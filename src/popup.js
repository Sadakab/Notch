/**
 * Notch toolbar popup: review list + settings (preferences sync via same storage + SW messages as content.js).
 */

const PREFS_STORAGE_KEY = "notch_prefs";
const SYNC_KEY_AUTO_SHOW_SIDEBAR = "autoShowSidebar";
const PREFERENCE_DEFAULTS = {
  displayName: "",
  companyName: "",
  avatar: null,
  logoDataUrl: null,
  panelPosition: "bottom-right",
  autoPause: true,
  floatPanel: false,
  timestampFormat: "short",
  notifyOnComment: true,
  notifyOnReaction: true,
  notifyOnReply: true,
};

const AVATAR_DATA_URL_MAX_LEN = 7000;
const COMPANY_LOGO_DATA_URL_MAX_LEN = 48000;

/** Toolbar popup instant paint + background refresh (chrome.storage.local). */
const POPUP_CACHE_KEY_CONFIG = "notch_supabase_config";
const POPUP_CACHE_KEY_USER = "notch_popup_user";
const POPUP_CACHE_KEY_REVIEWS = "notch_popup_reviews";
/** Serialized settings panel state (user + prefs) for instant open; refreshed with home view fetches. */
const POPUP_CACHE_KEY_SETTINGS = "notch_popup_settings";

let settingsSession = {
  user: /** @type {{ id?: string; email?: string; plan?: string; billingPortalUrl?: string } | null} */ (null),
  pro: false,
};
let changeEmailCooldownUntil = 0;
let changeEmailCooldownTimer = null;
let proPollTimer = null;
let proPollDeadline = 0;

function normalizeUuidForCompare(u) {
  return String(u || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "");
}

function collabHostStorageKey(platform, clipId) {
  return "markframe_collab_host_" + platform + "_" + encodeURIComponent(clipId);
}

function collabHostKeysToTry(platform, clipId) {
  const keys = [collabHostStorageKey(platform, clipId)];
  if (platform === "dropbox" && typeof clipId === "string" && clipId.indexOf("?") !== -1) {
    keys.push(collabHostStorageKey(platform, clipId.slice(0, clipId.indexOf("?"))));
  }
  return keys;
}

function normalizeCommentAvatarUrl(v) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s) return "";
  if (s.startsWith("https://")) return s;
  if (s.startsWith("data:image/")) return s;
  return "";
}

function normalizePanelPositionValue(v) {
  const p = String(v || "").trim().toLowerCase();
  if (p === "top left" || p === "tl" || p === "top-left") return "top-left";
  if (p === "top right" || p === "tr" || p === "top-right") return "top-right";
  if (p === "bottom left" || p === "bl" || p === "bottom-left") return "bottom-left";
  return "bottom-right";
}

function normalizeTimestampFormatValue(v) {
  const raw = String(v || "").trim();
  if (raw === "00:00:39" || raw.toLowerCase() === "long") return "long";
  return "short";
}

function normalizePreferences(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const avatarRaw = src.avatar;
  const logoRaw = src.logoDataUrl;
  return {
    displayName: String(src.displayName || "").trim(),
    companyName: String(src.companyName || "").trim(),
    avatar:
      typeof avatarRaw === "string" && normalizeCommentAvatarUrl(avatarRaw)
        ? normalizeCommentAvatarUrl(avatarRaw)
        : null,
    logoDataUrl:
      typeof logoRaw === "string" && normalizeCommentAvatarUrl(logoRaw)
        ? normalizeCommentAvatarUrl(logoRaw)
        : null,
    panelPosition: normalizePanelPositionValue(src.panelPosition),
    autoPause: src.autoPause !== false,
    floatPanel: !!src.floatPanel,
    timestampFormat: normalizeTimestampFormatValue(src.timestampFormat),
    notifyOnComment: src.notifyOnComment !== false,
    notifyOnReaction: src.notifyOnReaction !== false,
    notifyOnReply: src.notifyOnReply !== false,
  };
}

function showEl(el, on) {
  if (!el) return;
  el.hidden = !on;
  el.classList.toggle("np-hidden", !on);
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (r) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(r);
      });
    } catch {
      resolve(null);
    }
  });
}

async function loadCachedPreferences() {
  const got = await chrome.storage.local.get(PREFS_STORAGE_KEY);
  return normalizePreferences({ ...PREFERENCE_DEFAULTS, ...(got[PREFS_STORAGE_KEY] || {}) });
}

async function loadAutoShowSidebarFromSync() {
  try {
    const got = await chrome.storage.sync.get({ [SYNC_KEY_AUTO_SHOW_SIDEBAR]: true });
    return got[SYNC_KEY_AUTO_SHOW_SIDEBAR] !== false;
  } catch {
    return true;
  }
}

async function saveAutoShowSidebarToSync(on) {
  try {
    await chrome.storage.sync.set({ [SYNC_KEY_AUTO_SHOW_SIDEBAR]: !!on });
  } catch {
    /* ignore */
  }
}

async function saveCachedPreferences(nextPrefs) {
  const n = normalizePreferences({ ...PREFERENCE_DEFAULTS, ...nextPrefs });
  await chrome.storage.local.set({ [PREFS_STORAGE_KEY]: n });
  return n;
}

async function updateCachedPreferences(patch) {
  const cur = await loadCachedPreferences();
  return saveCachedPreferences({ ...cur, ...patch });
}

async function pushPreferencesToSupabase(prefs) {
  const r = await sendMessage("MF_SUPABASE_SET_PREFERENCES", { preferences: prefs });
  if (r?.ok && r.preferences) {
    await saveCachedPreferences(normalizePreferences(r.preferences));
  }
  return r;
}

function avatarFallbackLetter(name) {
  const s = (name || "You").trim();
  if (!s) return "?";
  const cp = s.codePointAt(0);
  return String.fromCodePoint(cp).toUpperCase();
}

function compressImageFile(file, opts) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("Choose an image file."));
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxPx = Math.max(1, Number(opts?.maxPx) || 72);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const scale = Math.min(1, maxPx / Math.max(w, h, 1));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not process image."));
          return;
        }
        ctx.drawImage(img, 0, 0, cw, ch);
        const mimeType = typeof opts?.mimeType === "string" ? opts.mimeType : "image/jpeg";
        const maxLen = Math.max(1000, Number(opts?.maxLen) || AVATAR_DATA_URL_MAX_LEN);
        let q = Math.max(0.01, Math.min(1, Number(opts?.initialQuality) || 0.82));
        const minQuality = Math.max(0.01, Math.min(1, Number(opts?.minQuality) || 0.28));
        const qualityStep = Math.max(0.01, Math.min(0.5, Number(opts?.qualityStep) || 0.08));
        let data = canvas.toDataURL(mimeType, q);
        while (data.length > maxLen && q > minQuality) {
          q -= qualityStep;
          data = canvas.toDataURL(mimeType, q);
        }
        if (data.length > maxLen) {
          reject(new Error("Image is still too large after resizing. Try a smaller photo."));
          return;
        }
        resolve(data);
      };
      img.onerror = () => reject(new Error("Could not read that image."));
      img.src = /** @type {string} */ (r.result);
    };
    r.onerror = () => reject(new Error("Could not read file."));
    r.readAsDataURL(file);
  });
}

function compressAvatarFile(file) {
  return compressImageFile(file, {
    maxPx: 72,
    maxLen: AVATAR_DATA_URL_MAX_LEN,
    mimeType: "image/jpeg",
    initialQuality: 0.82,
    minQuality: 0.28,
    qualityStep: 0.08,
  });
}

function compressCompanyLogoFile(file) {
  return compressImageFile(file, {
    maxPx: 320,
    maxLen: COMPANY_LOGO_DATA_URL_MAX_LEN,
    mimeType: "image/webp",
    initialQuality: 0.92,
    minQuality: 0.6,
    qualityStep: 0.05,
  });
}

function showToast(text) {
  const el = document.getElementById("np-toast");
  if (!el) return;
  el.textContent = text || "";
  showEl(el, !!text);
  if (text) {
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => showEl(el, false), 2800);
  }
}

/** @type {((value: boolean) => void) | null} */
let npConfirmResolve = null;

function onNpConfirmKeydown(e) {
  if (e.key !== "Escape") return;
  if (!npConfirmResolve) return;
  e.preventDefault();
  finishNpConfirm(false);
}

function finishNpConfirm(value) {
  const fn = npConfirmResolve;
  npConfirmResolve = null;
  document.removeEventListener("keydown", onNpConfirmKeydown);
  const root = document.getElementById("np-confirm");
  if (root) showEl(root, false);
  if (fn) fn(value);
}

let npConfirmWired = false;

function wireNpConfirmDialogOnce() {
  if (npConfirmWired) return;
  npConfirmWired = true;
  const root = document.getElementById("np-confirm");
  const backdrop = document.getElementById("np-confirm-backdrop");
  const panel = document.getElementById("np-confirm-panel");
  const cancel = document.getElementById("np-confirm-cancel");
  const ok = document.getElementById("np-confirm-ok");
  if (!root || !backdrop || !panel || !cancel || !ok) return;
  backdrop.addEventListener("click", () => finishNpConfirm(false));
  panel.addEventListener("click", (e) => e.stopPropagation());
  cancel.addEventListener("click", () => finishNpConfirm(false));
  ok.addEventListener("click", () => finishNpConfirm(true));
}

/**
 * @param {{ title: string; message: string; confirmLabel?: string; danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
function openNpConfirm(opts) {
  wireNpConfirmDialogOnce();
  const root = document.getElementById("np-confirm");
  const titleEl = document.getElementById("np-confirm-title");
  const msgEl = document.getElementById("np-confirm-msg");
  const okBtn = document.getElementById("np-confirm-ok");
  const cancelBtn = document.getElementById("np-confirm-cancel");
  if (!root || !titleEl || !msgEl || !okBtn || !cancelBtn) return Promise.resolve(false);
  if (npConfirmResolve) finishNpConfirm(false);

  return new Promise((resolve) => {
    npConfirmResolve = resolve;
    titleEl.textContent = opts.title || "";
    msgEl.textContent = opts.message || "";
    okBtn.textContent = opts.confirmLabel || "OK";
    okBtn.classList.toggle("np-confirm-ok--danger", !!opts.danger);
    document.addEventListener("keydown", onNpConfirmKeydown);
    showEl(root, true);
    cancelBtn.focus();
  });
}

function applyAvatarPreview(src, fallbackLabel) {
  const img = document.getElementById("np-avatar-preview");
  const fb = document.getElementById("np-avatar-fallback");
  if (!img || !fb) return;
  fb.textContent = avatarFallbackLetter(fallbackLabel);
  if (src) {
    img.classList.add("np-hidden");
    fb.classList.remove("np-hidden");
    img.onload = () => {
      img.classList.remove("np-hidden");
      fb.classList.add("np-hidden");
    };
    img.onerror = () => {
      img.classList.add("np-hidden");
      fb.classList.remove("np-hidden");
    };
    img.src = src;
    if (img.complete && img.naturalWidth > 0) {
      img.classList.remove("np-hidden");
      fb.classList.add("np-hidden");
    }
  } else {
    img.removeAttribute("src");
    img.classList.add("np-hidden");
    fb.classList.remove("np-hidden");
  }
}

function applyLogoPreview(src) {
  const img = document.getElementById("np-logo-preview");
  const ph = document.getElementById("np-logo-placeholder");
  if (!img || !ph) return;
  if (src) {
    ph.classList.add("np-hidden");
    img.classList.remove("np-hidden");
    img.src = src;
  } else {
    img.removeAttribute("src");
    img.classList.add("np-hidden");
    ph.classList.remove("np-hidden");
  }
}

function setSignedInSectionsVisible(signedIn) {
  document.querySelectorAll(".np-settings-signed-in").forEach((el) => {
    el.classList.toggle("np-hidden", !signedIn);
    if (el instanceof HTMLElement) el.hidden = !signedIn;
  });
}

function applyProRowsLocked(pro) {
  document.querySelectorAll(".np-pro-row").forEach((el) => {
    el.classList.toggle("np-pro-locked", !pro);
    el.querySelectorAll("input").forEach((inp) => {
      inp.disabled = !pro;
    });
  });
  const logoBtn = document.getElementById("np-pick-logo");
  if (logoBtn) logoBtn.disabled = !pro;
}

/**
 * Persist settings snapshot from `MF_SUPABASE_GET_USER` response. On transport errors (`!r.ok`), leaves storage unchanged.
 * @param {{ ok?: boolean; configured?: boolean; user?: { id?: string; email?: string; plan?: string; billingPortalUrl?: string; preferences?: object } | null } | null} r
 */
async function writePopupSettingsCacheFromGetUser(r) {
  if (!r || r.configured === false) return;
  const at = Date.now();
  if (!r.ok) return;
  if (!r.user?.id) {
    const prefs = await loadCachedPreferences();
    await chrome.storage.local.set({
      [POPUP_CACHE_KEY_SETTINGS]: { at, ok: true, user: null, prefs },
    });
    return;
  }
  const merged = { ...PREFERENCE_DEFAULTS, ...normalizePreferences(r.user.preferences || {}) };
  const cur = await loadCachedPreferences();
  if (JSON.stringify(cur) !== JSON.stringify(merged)) {
    await saveCachedPreferences(merged);
  }
  await chrome.storage.local.set({
    [POPUP_CACHE_KEY_SETTINGS]: {
      at,
      ok: true,
      user: {
        id: r.user.id,
        email: String(r.user.email || ""),
        plan: String(r.user.plan || ""),
        billingPortalUrl: String(r.user.billingPortalUrl || ""),
      },
      prefs: merged,
    },
  });
}

function settingsViewFingerprint(user, prefs, pro) {
  const p = normalizePreferences({ ...PREFERENCE_DEFAULTS, ...prefs });
  return JSON.stringify({
    uid: user?.id || null,
    email: user?.email || null,
    pro: !!pro,
    prefs: p,
  });
}

function isUsablePopupSettingsCache(entry) {
  if (!entry || typeof entry !== "object" || !entry.prefs || typeof entry.prefs !== "object") return false;
  if (entry.user === null) return true;
  if (entry.user && typeof entry.user === "object" && String(entry.user.id || "").trim()) return true;
  return false;
}

async function pullUserAndPreferences() {
  const r = await sendMessage("MF_SUPABASE_GET_USER");
  if (!r?.ok || !r?.user?.id) {
    settingsSession = { user: null, pro: false };
    if (r?.ok) await writePopupSettingsCacheFromGetUser(r);
    return { user: null, prefs: await loadCachedPreferences(), pro: false };
  }
  const incoming = normalizePreferences(r.user.preferences || {});
  const merged = { ...PREFERENCE_DEFAULTS, ...incoming };
  const cur = await loadCachedPreferences();
  if (JSON.stringify(cur) !== JSON.stringify(merged)) {
    await saveCachedPreferences(merged);
  }
  const pro = String(r.user.plan || "").trim().toLowerCase() === "pro";
  settingsSession = { user: r.user, pro };
  await writePopupSettingsCacheFromGetUser(r);
  return { user: r.user, prefs: merged, pro };
}

function fillSettingsForm(prefs, email) {
  const em = String(email || "").trim();
  const dn = document.getElementById("np-display-name");
  if (dn) dn.value = prefs.displayName || em || "";
  document.getElementById("np-company-name").value = prefs.companyName || "";
  document.getElementById("np-timestamp-format").value = prefs.timestampFormat === "long" ? "long" : "short";
  document.getElementById("np-notify-comment").checked = !!prefs.notifyOnComment;
  document.getElementById("np-notify-reaction").checked = !!prefs.notifyOnReaction;
  document.getElementById("np-notify-reply").checked = !!prefs.notifyOnReply;
  const accEl = document.getElementById("np-account-email");
  if (accEl) accEl.textContent = em || "Not signed in";
  const label = document.getElementById("np-display-name").value.trim() || em || "You";
  applyAvatarPreview(prefs.avatar || "", label);
  applyLogoPreview(prefs.logoDataUrl || "");
}

function updatePlanUi(pro) {
  const badge = document.getElementById("np-plan-badge");
  const up = document.getElementById("np-upgrade-pro");
  const bill = document.getElementById("np-manage-billing");
  if (badge) badge.textContent = pro ? "PRO" : "Free";
  if (up) showEl(up, !pro);
  if (bill) showEl(bill, !!pro);
}

async function applySettingsViewUi(user, prefs, pro) {
  setSignedInSectionsVisible(!!user);
  fillSettingsForm(prefs, user?.email || "");
  const autoShowEl2 = document.getElementById("np-auto-show-sidebar");
  if (autoShowEl2 instanceof HTMLInputElement) {
    autoShowEl2.checked = await loadAutoShowSidebarFromSync();
  }
  updatePlanUi(pro);
  applyProRowsLocked(pro);
  if (!pro) {
    for (const id of ["np-notify-comment", "np-notify-reaction", "np-notify-reply"]) {
      const el = document.getElementById(id);
      if (el instanceof HTMLInputElement) el.checked = false;
    }
  }

  const openChange = document.getElementById("np-open-change-email");
  if (openChange) openChange.disabled = !user?.email;
  updateChangeEmailButton();
}

/** When settings is open, refresh from network and repaint if data changed. */
async function refreshSettingsViewFromNetwork(prevFp) {
  try {
    const cfg = await sendMessage("MF_SUPABASE_CONFIG");
    if (!cfg?.configured) return;
    const r = await sendMessage("MF_SUPABASE_GET_USER");
    if (!r?.ok) return;
    await writePopupSettingsCacheFromGetUser(r);
    const view = document.getElementById("np-view-settings");
    if (!view || view.hidden || view.classList.contains("np-hidden")) return;

    let user;
    let prefs;
    let pro;
    if (!r.user?.id) {
      settingsSession = { user: null, pro: false };
      user = null;
      prefs = await loadCachedPreferences();
      pro = false;
    } else {
      const merged = { ...PREFERENCE_DEFAULTS, ...normalizePreferences(r.user.preferences || {}) };
      pro = String(r.user.plan || "").trim().toLowerCase() === "pro";
      settingsSession = { user: r.user, pro };
      user = r.user;
      prefs = merged;
    }
    const nextFp = settingsViewFingerprint(user, prefs, pro);
    if (nextFp === prevFp) return;
    await applySettingsViewUi(user, prefs, pro);
  } catch {
    /* keep current UI */
  }
}

async function loadSettingsView() {
  const warn = document.getElementById("np-settings-config-warn");
  const cfg = await sendMessage("MF_SUPABASE_CONFIG");
  if (!cfg?.configured) {
    showEl(warn, true);
    warn.textContent =
      "Add your Supabase key in src/supabase-config.js, run npm run build, and reload the extension.";
    setSignedInSectionsVisible(false);
    const prefs = await loadCachedPreferences();
    fillSettingsForm(prefs, "");
    document.getElementById("np-timestamp-format").value = prefs.timestampFormat === "long" ? "long" : "short";
    const autoShowEl = document.getElementById("np-auto-show-sidebar");
    if (autoShowEl instanceof HTMLInputElement) {
      autoShowEl.checked = await loadAutoShowSidebarFromSync();
    }
    return;
  }
  showEl(warn, false);

  let cacheEntry = null;
  try {
    const got = await chrome.storage.local.get(POPUP_CACHE_KEY_SETTINGS);
    cacheEntry = got[POPUP_CACHE_KEY_SETTINGS];
  } catch {
    cacheEntry = null;
  }

  if (isUsablePopupSettingsCache(cacheEntry)) {
    const prefs = normalizePreferences({ ...PREFERENCE_DEFAULTS, ...cacheEntry.prefs });
    const cachedUser = cacheEntry.user;
    const user =
      cachedUser && cachedUser.id
        ? {
            id: cachedUser.id,
            email: cachedUser.email,
            plan: cachedUser.plan,
            billingPortalUrl: cachedUser.billingPortalUrl,
          }
        : null;
    const pro = user ? String(user.plan || "").trim().toLowerCase() === "pro" : false;
    settingsSession = { user, pro };
    const prevFp = settingsViewFingerprint(user, prefs, pro);
    await applySettingsViewUi(user, prefs, pro);
    void refreshSettingsViewFromNetwork(prevFp);
    return;
  }

  const { user, prefs, pro } = await pullUserAndPreferences();
  await applySettingsViewUi(user, prefs, pro);
}

function stopProPoll() {
  if (proPollTimer) {
    window.clearInterval(proPollTimer);
    proPollTimer = null;
  }
  proPollDeadline = 0;
}

function startProPoll() {
  stopProPoll();
  proPollDeadline = Date.now() + 2 * 60 * 1000;
  proPollTimer = window.setInterval(async () => {
    if (Date.now() >= proPollDeadline) {
      stopProPoll();
      return;
    }
    const r = await sendMessage("MF_SUPABASE_GET_USER");
    const pro = String(r?.user?.plan || "").trim().toLowerCase() === "pro";
    if (!pro) return;
    settingsSession.pro = true;
    settingsSession.user = r.user;
    stopProPoll();
    await pullUserAndPreferences();
    updatePlanUi(true);
    applyProRowsLocked(true);
    const st = document.getElementById("np-upgrade-status");
    if (st) {
      st.textContent = "";
      showEl(st, false);
    }
    showToast("You're on Pro.");
  }, 3000);
}

async function startUpgradeCheckoutFlow() {
  const st = document.getElementById("np-upgrade-status");
  if (st) {
    st.textContent = "";
    showEl(st, false);
  }
  let storageSession = null;
  try {
    const authBlob = await chrome.storage.local.get("sb-notch-auth");
    const raw = authBlob?.["sb-notch-auth"];
    if (typeof raw === "string") storageSession = JSON.parse(raw);
    else if (raw && typeof raw === "object") storageSession = raw;
  } catch {
    storageSession = null;
  }
  const userId = String(storageSession?.user?.id || "").trim();
  const email = String(storageSession?.user?.email || "").trim();
  if (!userId || !email) {
    if (st) {
      st.textContent = "Please sign in first.";
      st.classList.remove("np-ok", "np-err");
      showEl(st, true);
    }
    return;
  }
  try {
    const resp = await fetch("https://notch.video/.netlify/functions/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, email }),
    });
    if (!resp.ok) throw new Error(String(resp.status || "checkout_failed"));
    const data = await resp.json();
    const url = String(data?.url || "").trim();
    if (!url) throw new Error("missing_checkout_url");
    const opened = await sendMessage("MF_OPEN_TAB", { url });
    if (!opened?.ok) throw new Error(String(opened?.error || "open_tab_failed"));
    startProPoll();
  } catch {
    if (st) {
      st.textContent = "Something went wrong. Please try again.";
      st.classList.add("np-err");
      showEl(st, true);
    }
  }
}

function clearChangeEmailCooldownTimer() {
  if (changeEmailCooldownTimer) {
    window.clearInterval(changeEmailCooldownTimer);
    changeEmailCooldownTimer = null;
  }
}

function updateChangeEmailButton() {
  const btn = document.getElementById("np-open-change-email");
  if (!(btn instanceof HTMLButtonElement)) return;
  const remainingMs = changeEmailCooldownUntil - Date.now();
  if (remainingMs <= 0) {
    btn.textContent = "Change";
    btn.disabled = !settingsSession.user?.email;
    clearChangeEmailCooldownTimer();
    return;
  }
  btn.textContent = `Change (${Math.ceil(remainingMs / 1000)}s)`;
  btn.disabled = true;
}

function startChangeEmailCooldown() {
  changeEmailCooldownUntil = Date.now() + 60 * 1000;
  updateChangeEmailButton();
  clearChangeEmailCooldownTimer();
  changeEmailCooldownTimer = window.setInterval(updateChangeEmailButton, 1000);
}

async function saveDisplayNameFromInput() {
  if (!settingsSession.user?.id) return;
  const inp = document.getElementById("np-display-name");
  const v = String(inp?.value || "").trim();
  const email = String(settingsSession.user?.email || "").trim();
  let displayName = v;
  if (!v || (email && v.toLowerCase() === email.toLowerCase())) displayName = "";
  const next = await updateCachedPreferences({ displayName });
  const r = await pushPreferencesToSupabase(next);
  if (!r?.ok) showToast(r?.error || "Could not save display name.");
  else applyAvatarPreview(next.avatar || "", inp?.value.trim() || email || "You");
}

function wireSettingsHandlers() {
  document.getElementById("np-settings-back")?.addEventListener("click", () => {
    showEl(document.getElementById("np-view-settings"), false);
    showEl(document.getElementById("np-view-home"), true);
    void runHomeView();
  });

  document.getElementById("np-open-settings")?.addEventListener("click", () => {
    showEl(document.getElementById("np-view-home"), false);
    showEl(document.getElementById("np-view-settings"), true);
    void loadSettingsView();
  });

  document.getElementById("np-display-name")?.addEventListener("input", () => {
    const inp = document.getElementById("np-display-name");
    const em = String(settingsSession.user?.email || "").trim();
    const fb = document.getElementById("np-avatar-fallback");
    if (fb) fb.textContent = avatarFallbackLetter((inp?.value || "").trim() || em || "You");
  });
  document.getElementById("np-display-name")?.addEventListener("change", () => void saveDisplayNameFromInput());

  document.getElementById("np-company-name")?.addEventListener("change", async () => {
    if (!settingsSession.user?.id) return;
    const v = document.getElementById("np-company-name")?.value.trim() ?? "";
    const next = await updateCachedPreferences({ companyName: v });
    const r = await pushPreferencesToSupabase(next);
    if (!r?.ok) showToast(r?.error || "Could not save.");
  });

  document.getElementById("np-timestamp-format")?.addEventListener("change", async () => {
    const sel = document.getElementById("np-timestamp-format");
    const fmt = sel?.value === "long" ? "long" : "short";
    const next = await updateCachedPreferences({ timestampFormat: fmt });
    const r = await pushPreferencesToSupabase(next);
    if (!r?.ok) showToast(r?.error || "Could not save.");
  });

  document.getElementById("np-auto-show-sidebar")?.addEventListener("change", async () => {
    const el = document.getElementById("np-auto-show-sidebar");
    const on = el instanceof HTMLInputElement ? el.checked : true;
    await saveAutoShowSidebarToSync(on);
  });

  const nids = ["np-notify-comment", "np-notify-reaction", "np-notify-reply"];
  const keys = ["notifyOnComment", "notifyOnReaction", "notifyOnReply"];
  nids.forEach((id, i) => {
    document.getElementById(id)?.addEventListener("change", async () => {
      if (!settingsSession.pro) return;
      const el = document.getElementById(id);
      const patch = { [keys[i]]: el instanceof HTMLInputElement ? el.checked : false };
      const next = await updateCachedPreferences(patch);
      const r = await pushPreferencesToSupabase(next);
      if (!r?.ok) showToast(r?.error || "Could not save.");
    });
  });

  document.getElementById("np-pick-profile-avatar")?.addEventListener("click", () => {
    document.getElementById("np-profile-avatar-file")?.click();
  });
  document.getElementById("np-profile-avatar-file")?.addEventListener("change", () => {
    const inp = document.getElementById("np-profile-avatar-file");
    const f = inp instanceof HTMLInputElement ? inp.files?.[0] : null;
    if (!f || !settingsSession.user?.id) return;
    compressAvatarFile(f)
      .then(async (dataUrl) => {
        const next = await updateCachedPreferences({ avatar: dataUrl });
        const r = await pushPreferencesToSupabase(next);
        if (!r?.ok) throw new Error(r?.error || "Save failed");
        const nameInp = document.getElementById("np-display-name");
        const em = String(settingsSession.user?.email || "").trim();
        applyAvatarPreview(dataUrl, (nameInp?.value || "").trim() || em || "You");
        showToast("Profile photo updated.");
      })
      .catch((err) => showToast(err.message || "Could not use that image."));
    if (inp instanceof HTMLInputElement) inp.value = "";
  });

  document.getElementById("np-pick-logo")?.addEventListener("click", () => {
    if (!settingsSession.pro) return;
    document.getElementById("np-logo-file")?.click();
  });
  document.getElementById("np-logo-file")?.addEventListener("change", () => {
    const inp = document.getElementById("np-logo-file");
    const f = inp instanceof HTMLInputElement ? inp.files?.[0] : null;
    if (!f || !settingsSession.pro) return;
    compressCompanyLogoFile(f)
      .then(async (dataUrl) => {
        const normalized = normalizeCommentAvatarUrl(dataUrl);
        if (!normalized) throw new Error("Could not use that image.");
        const next = await updateCachedPreferences({ logoDataUrl: normalized });
        const r = await pushPreferencesToSupabase(next);
        if (!r?.ok) throw new Error(r?.error || "Save failed");
        applyLogoPreview(normalized);
        showToast("Logo saved.");
      })
      .catch((err) => showToast(err.message || "Could not use that image."));
    if (inp instanceof HTMLInputElement) inp.value = "";
  });

  const setChStatus = (text, kind) => {
    const el = document.getElementById("np-change-email-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "np-status" + (kind === "err" ? " np-err" : kind === "ok" ? " np-ok" : "");
  };

  document.getElementById("np-open-change-email")?.addEventListener("click", () => {
    const form = document.getElementById("np-change-email-form");
    const notice = document.getElementById("np-change-email-notice");
    showEl(form, true);
    if (notice) showEl(notice, false);
    setChStatus("", "");
    const ni = document.getElementById("np-new-email");
    if (ni instanceof HTMLInputElement) {
      ni.value = "";
      requestAnimationFrame(() => ni.focus());
    }
  });
  document.getElementById("np-cancel-change-email")?.addEventListener("click", () => {
    showEl(document.getElementById("np-change-email-form"), false);
    setChStatus("", "");
  });
  document.getElementById("np-submit-change-email")?.addEventListener("click", async () => {
    const newEmail = String(document.getElementById("np-new-email")?.value || "").trim();
    const btn = document.getElementById("np-submit-change-email");
    if (!newEmail) {
      setChStatus("Enter a new email address.", "err");
      return;
    }
    const currentEmail = String(settingsSession.user?.email || "").trim();
    if (currentEmail && newEmail.toLowerCase() === currentEmail.toLowerCase()) {
      setChStatus("Use a different email address.", "err");
      return;
    }
    if (btn instanceof HTMLButtonElement) btn.disabled = true;
    setChStatus("", "");
    try {
      const r = await sendMessage("MF_SUPABASE_CHANGE_EMAIL", { email: newEmail });
      if (!r?.ok) {
        setChStatus(r?.error || "Could not send confirmation email.", "err");
        return;
      }
      showEl(document.getElementById("np-change-email-form"), false);
      const notice = document.getElementById("np-change-email-notice");
      if (notice) {
        notice.textContent = "Check your new inbox for a confirmation link";
        showEl(notice, true);
      }
      startChangeEmailCooldown();
    } catch (e) {
      setChStatus(String(e?.message || e || "Could not send confirmation email."), "err");
    } finally {
      if (btn instanceof HTMLButtonElement) btn.disabled = false;
    }
  });

  document.getElementById("np-upgrade-pro")?.addEventListener("click", () => void startUpgradeCheckoutFlow());
  document.getElementById("np-manage-billing")?.addEventListener("click", async () => {
    const r = await sendMessage("MF_SUPABASE_GET_USER");
    const url = String(r?.user?.billingPortalUrl || "").trim() || "https://notch.video/billing";
    void chrome.tabs.create({ url, active: true });
  });

  document.getElementById("np-sign-out")?.addEventListener("click", async () => {
    try {
      await sendMessage("MF_SUPABASE_SIGN_OUT");
      await clearPopupSessionCache();
      showEl(document.getElementById("np-view-settings"), false);
      showEl(document.getElementById("np-view-home"), true);
      await runHomeView();
    } catch {
      showToast("Sign out failed — try again.");
    }
  });

  document.getElementById("np-delete-account")?.addEventListener("click", async () => {
    if (!window.confirm("Delete your account and cloud data? This cannot be undone.")) return;
    const r = await sendMessage("MF_SUPABASE_DELETE_USER");
    showToast(r?.ok ? "Account deleted." : r?.error || "Could not delete account.");
    if (r?.ok) {
      await clearPopupSessionCache();
      showEl(document.getElementById("np-view-settings"), false);
      showEl(document.getElementById("np-view-home"), true);
      await runHomeView();
    }
  });
}

let settingsFormWired = false;
function wireSettingsFormOnce() {
  if (settingsFormWired) return;
  settingsFormWired = true;
  wireSettingsHandlers();
}

function setSidebarToggleButtonState(btn, sidebarVisible) {
  const vis = !!sidebarVisible;
  btn.dataset.sidebarVisible = vis ? "1" : "0";
  btn.title = vis ? "Hide sidebar" : "Show sidebar";
  btn.setAttribute("aria-label", vis ? "Hide sidebar" : "Show sidebar");
}

let popupHomeChromeWired = false;
let popupReviewsCacheListenerWired = false;

function isPopupHomeViewActive() {
  const home = document.getElementById("np-view-home");
  if (!home) return false;
  return !home.hidden && !home.classList.contains("np-hidden");
}

function wirePopupReviewsCacheListenerOnce() {
  if (popupReviewsCacheListenerWired) return;
  popupReviewsCacheListenerWired = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, POPUP_CACHE_KEY_REVIEWS)) return;
    void refreshPopupHomeFromReviewsCacheOnly();
  });
}

/** Re-render reviews list from storage when cache updates (e.g. new review from content script). */
async function refreshPopupHomeFromReviewsCacheOnly() {
  if (!isPopupHomeViewActive()) return;
  const els = getPopupHomeElements();
  let cache = {};
  try {
    cache = await chrome.storage.local.get([
      POPUP_CACHE_KEY_CONFIG,
      POPUP_CACHE_KEY_USER,
      POPUP_CACHE_KEY_REVIEWS,
    ]);
  } catch {
    return;
  }
  if (!isCompletePopupCache(cache)) return;
  const cfg = cache[POPUP_CACHE_KEY_CONFIG];
  const userObj = cache[POPUP_CACHE_KEY_USER];
  const uid = String(userObj?.id || "").trim();
  const user = uid ? { id: uid, email: userObj?.email || "" } : null;
  const listRes =
    uid && cache[POPUP_CACHE_KEY_REVIEWS] ? cache[POPUP_CACHE_KEY_REVIEWS] : { ok: true, items: [] };
  await applyHomeViewRender(els, cfg, user, listRes);
}

function wirePopupHomeChromeOnce() {
  if (popupHomeChromeWired) return;
  popupHomeChromeWired = true;
  wirePopupReviewsCacheListenerOnce();
  document.getElementById("np-toggle-sidebar-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("np-toggle-sidebar-btn");
    if (!btn) return;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.id == null) return;
      const currentlyVisible = btn.dataset.sidebarVisible === "1";
      await chrome.tabs.sendMessage(tab.id, {
        type: "MF_POPUP_SET_SIDEBAR_TAB_HIDDEN",
        hidden: currentlyVisible,
      });
      setSidebarToggleButtonState(btn, !currentlyVisible);
    } catch {
      showToast("Could not update sidebar on this tab.");
    }
  });
}

// —— Home view (reviews list) —— //

async function openVideoTab(platform, clipId) {
  return sendMessage("NOTCH_OPEN_VIDEO_TAB", { platform, clipId });
}

function getPopupHomeElements() {
  return {
    loading: document.getElementById("np-loading"),
    skeleton: document.getElementById("np-home-skeleton"),
    gate: document.getElementById("np-gate"),
    empty: document.getElementById("np-empty"),
    errBox: document.getElementById("np-error"),
    errText: document.getElementById("np-error-text"),
    reviewsEl: document.getElementById("np-reviews"),
    emailEl: document.getElementById("np-email"),
  };
}

/** Dropbox shared-file preview paths (aligned with content.js `isDropboxShareViewerPath`). */
function isDropboxShareViewerPathname(pathname) {
  if (!pathname || typeof pathname !== "string") return false;
  if (/^\/s\/[^/]+\/.+/i.test(pathname)) return true;
  if (/^\/scl\/fi\/[^/]+\/.+/i.test(pathname)) return true;
  if (/^\/scl\/fo\/[^/]+\/[^/]+\/.+/i.test(pathname)) return true;
  return false;
}

/** URL-only: YouTube video id (watch, live, shorts, embed, youtu.be) — same rules as content.js `parseYoutubeVideoId`. */
function parseYoutubeVideoIdFromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    const ytHosts = new Set([
      "www.youtube.com",
      "youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "www.youtube-nocookie.com",
      "youtube-nocookie.com",
      "youtu.be",
    ]);
    if (!ytHosts.has(h)) return null;
    if (h === "youtu.be") {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg && /^[A-Za-z0-9_-]{6,}$/.test(seg)) return seg;
      return null;
    }
    const fromQuery = u.searchParams.get("v");
    if (fromQuery) return fromQuery;
    const watchPath = u.pathname.match(/^\/watch\/([^/?#]+)/);
    if (watchPath && watchPath[1]) return watchPath[1];
    const livePath = u.pathname.match(/^\/live\/([^/?#]+)/);
    if (livePath && livePath[1]) return livePath[1];
    const shortsPath = u.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shortsPath && shortsPath[1].length >= 6) return shortsPath[1];
    const m = u.pathname.match(/\/embed\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    if (m) return m[1];
    const m2 = u.pathname.match(/\/embed\/([A-Za-z0-9_-]+)(?:\/|$)/);
    if (m2 && m2[1].length >= 6) return m2[1];
  } catch {
    /* ignore */
  }
  return null;
}

/** URL-only: Vimeo numeric id — aligned with content.js `parseVimeoClipIdFromUrl`. */
function parseVimeoClipIdFromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    const isPlayer = h === "player.vimeo.com";
    const isMain = h === "vimeo.com" || h === "www.vimeo.com";
    if (!isPlayer && !isMain) return null;
    const path = u.pathname;
    const parts = path.split("/").filter(Boolean);
    if (isPlayer) {
      const vi = parts.indexOf("video");
      if (vi >= 0 && parts[vi + 1] && /^\d+$/.test(parts[vi + 1])) return parts[vi + 1];
      const mPath = path.match(/\/(?:video\/)?(\d{5,})(?:\/|$)/);
      if (mPath) return mPath[1];
      const num = parts.find((p) => /^\d{5,}$/.test(p));
      return num || null;
    }
    if (parts.length === 1 && /^\d+$/.test(parts[0])) return parts[0];
    const vi = parts.indexOf("video");
    if (vi >= 0 && parts[vi + 1] && /^\d+$/.test(parts[vi + 1])) return parts[vi + 1];
    const vdi = parts.indexOf("videos");
    if (vdi >= 0 && parts[vdi + 1] && /^\d+$/.test(parts[vdi + 1])) return parts[vdi + 1];
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d{5,}$/.test(parts[i])) return parts[i];
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** URL-only: Loom share/embed id — aligned with content.js `parseLoomClipIdFromPathname`. */
function parseLoomClipIdFromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    const onLoom =
      h === "loom.com" || h === "www.loom.com" || (h.length > 10 && h.endsWith(".loom.com"));
    if (!onLoom) return null;
    if (!/\/(?:share|embed)\//i.test(u.pathname)) return null;
    const m = u.pathname.match(/\/(?:share|embed)\/([a-f0-9]{32})(?:\/|$|\?|#|\.)/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    /* ignore */
  }
  return null;
}

/** URL-only: Google Drive/Docs file id — aligned with content.js `parseGoogleDriveFileIdFromPathAndSearch`. */
function parseGoogleDriveFileIdFromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    if (h !== "drive.google.com" && h !== "docs.google.com") return null;
    const pathname = u.pathname;
    const sp = u.searchParams;
    const m = pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    if (m) return m[1];
    if (pathname === "/open") {
      const id = sp.get("id");
      if (id && /^[a-zA-Z0-9_-]{10,}$/.test(id)) return id;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * True when the tab URL is a specific clip/video page Notch can attach to (URL bar only),
 * not merely a supported host (e.g. YouTube home). Mirrors content.js URL parsing.
 */
function isSupportedNotchVideoUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (parseYoutubeVideoIdFromUrl(urlStr)) return true;
    if (parseVimeoClipIdFromUrl(urlStr)) return true;
    if (parseLoomClipIdFromUrl(urlStr)) return true;
    if (parseGoogleDriveFileIdFromUrl(urlStr)) return true;
    if (
      (h === "dropbox.com" || h === "www.dropbox.com" || h === "m.dropbox.com") &&
      isDropboxShareViewerPathname(u.pathname)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function refreshActiveTabSidebarToggleButton() {
  const btn = document.getElementById("np-toggle-sidebar-btn");
  if (!btn) return;
  showEl(btn, false);
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.id == null || !tab.url || !isSupportedNotchVideoUrl(tab.url)) return;
    const response = await chrome.tabs.sendMessage(tab.id, { type: "MF_GET_SIDEBAR_STATE" });
    if (!response || typeof response.isVisible !== "boolean") return;
    setSidebarToggleButtonState(btn, response.isVisible);
    showEl(btn, true);
  } catch {
    showEl(btn, false);
  }
}

function isCompletePopupCache(c) {
  const cfg = c[POPUP_CACHE_KEY_CONFIG];
  if (cfg == null || typeof cfg !== "object" || typeof cfg.configured !== "boolean") return false;
  if (!cfg.configured) return true;
  const u = c[POPUP_CACHE_KEY_USER];
  if (u == null || typeof u !== "object") return false;
  const id = String(u.id || "").trim();
  if (!id) return true;
  const rev = c[POPUP_CACHE_KEY_REVIEWS];
  return rev != null && typeof rev === "object" && Array.isArray(rev.items);
}

function popupHomeFingerprint(cfg, user, listRes) {
  const items = listRes?.ok && Array.isArray(listRes.items) ? listRes.items : [];
  const normalized = items.map((i) => ({
    p: i.platform,
    c: i.clipId,
    u: i.updatedAt,
    n: i.commentCount,
    t: i.title,
    o: i.reviewOwnerUserId,
    th: i.thumbnailUrl || "",
  }));
  return JSON.stringify({
    configured: !!(cfg && cfg.configured),
    uid: user?.id || null,
    email: user?.email || null,
    listOk: listRes?.ok === true,
    items: normalized,
  });
}

async function writePopupCache(cfg, user, listPayload) {
  const cfgObj =
    cfg && typeof cfg === "object"
      ? { ok: true, configured: !!cfg.configured, url: String(cfg.url || "") }
      : { ok: true, configured: false, url: "" };
  const uid = user && String(user.id || "").trim() ? String(user.id).trim() : "";
  const u = uid ? { id: uid, email: String(user?.email || "") } : { id: "", email: "" };
  const base = {
    [POPUP_CACHE_KEY_CONFIG]: cfgObj,
    [POPUP_CACHE_KEY_USER]: u,
  };
  const hasSignedInList =
    !!uid &&
    listPayload &&
    typeof listPayload === "object" &&
    listPayload.ok === true &&
    Array.isArray(listPayload.items);
  if (hasSignedInList) {
    await chrome.storage.local.set({
      ...base,
      [POPUP_CACHE_KEY_REVIEWS]: { ok: true, items: listPayload.items },
    });
  } else {
    await chrome.storage.local.remove([POPUP_CACHE_KEY_REVIEWS]);
    await chrome.storage.local.set(base);
  }
}

function clearPopupSessionCache() {
  return chrome.storage.local.remove([POPUP_CACHE_KEY_REVIEWS, POPUP_CACHE_KEY_USER, POPUP_CACHE_KEY_SETTINGS]);
}

async function applyHomeViewRender(els, cfg, user, listRes) {
  try {
    const { gate, empty, errBox, errText, reviewsEl, emailEl } = els;
    showEl(els.loading, false);
    showEl(els.skeleton, false);

    if (!cfg?.configured) {
      updateNpGateCopy(false);
      showEl(gate, true);
      setHeaderEmail(emailEl, "");
      setPopupSettingsButtonVisible(false);
      setPopupGateCompactLayout(true);
      showEl(empty, false);
      showEl(errBox, false);
      showEl(reviewsEl, false);
      return;
    }

    setHeaderEmail(emailEl, user?.email || "");

    if (!user?.id) {
      updateNpGateCopy(true);
      showEl(gate, true);
      ensureNpGateWired();
      setPopupSettingsButtonVisible(false);
      setPopupGateCompactLayout(true);
      showEl(empty, false);
      showEl(errBox, false);
      showEl(reviewsEl, false);
      return;
    }

    setPopupSettingsButtonVisible(true);
    setPopupGateCompactLayout(false);
    showEl(gate, false);

    if (!listRes?.ok || !Array.isArray(listRes.items)) {
      showEl(empty, false);
      showEl(reviewsEl, false);
      showEl(errBox, true);
      if (errText) errText.textContent = "Could not load reviews.";
      return;
    }

    const items = listRes.items.slice();
    const { mine, shared } = partitionDashboardItems(items, user.id);
    showEl(errBox, false);
    if (mine.length === 0 && shared.length === 0) {
      showEl(empty, true);
      showEl(reviewsEl, false);
    } else {
      showEl(empty, false);
      showEl(reviewsEl, true);
      renderReviewSections(reviewsEl, mine, shared);
    }
  } finally {
    void refreshActiveTabSidebarToggleButton();
  }
}

async function refreshPopupHomeFromNetwork(els, prevFp) {
  try {
    const [cfg, sess, listRes, getUserRes] = await Promise.all([
      sendMessage("MF_SUPABASE_CONFIG"),
      sendMessage("MF_SUPABASE_SESSION"),
      sendMessage("MF_CLOUD_LIST_CLIPS"),
      sendMessage("MF_SUPABASE_GET_USER"),
    ]);
    const user = sess?.user ?? null;
    const rawItems = listRes?.ok && Array.isArray(listRes.items) ? listRes.items.slice() : [];
    await Promise.all([enrichClipThumbnails(rawItems), writePopupSettingsCacheFromGetUser(getUserRes)]);
    const enrichedList = { ok: listRes?.ok === true, items: rawItems };
    const nextFp = popupHomeFingerprint(cfg, user, enrichedList);
    await writePopupCache(cfg, user, enrichedList);
    if (nextFp !== prevFp) {
      await applyHomeViewRender(els, cfg, user, enrichedList);
    }
  } catch {
    /* keep cached UI */
  }
}

function partitionDashboardItems(items, myId) {
  const mine = [];
  const shared = [];
  const id = myId && String(myId).trim();
  for (const item of items) {
    const owner = item.reviewOwnerUserId;
    if (!owner || !id || normalizeUuidForCompare(owner) === normalizeUuidForCompare(id)) {
      mine.push(item);
    } else {
      shared.push(item);
    }
  }
  const byUpdated = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  mine.sort(byUpdated);
  shared.sort(byUpdated);
  return { mine, shared };
}

async function patchNotchSharedReviewStorage(patch) {
  const curRaw = await chrome.storage.local.get("notch_shared_review");
  const cur = curRaw.notch_shared_review;
  const base = cur && typeof cur === "object" ? { ...cur } : {};
  await chrome.storage.local.set({ notch_shared_review: { ...base, ...patch } });
}

async function prepareSharedReviewOpen(item) {
  const ownerId = item.reviewOwnerUserId && String(item.reviewOwnerUserId).trim();
  if (!ownerId) return;
  await chrome.storage.local.set({ [collabHostStorageKey(item.platform, item.clipId)]: ownerId });
  await patchNotchSharedReviewStorage({
    uid: ownerId,
    platform: item.platform,
    clip: item.clipId,
    needsDbJoin: false,
    receivedAt: Date.now(),
  });
}

async function openReviewFromPopup(item, sharedWithMe) {
  if (sharedWithMe) await prepareSharedReviewOpen(item);
  await openVideoTab(item.platform, item.clipId);
  window.close();
}

function fetchVimeoThumbFromBackground(clipId) {
  if (!clipId) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "FETCH_VIMEO_OEMBED_THUMB", clipId: String(clipId) }, (r) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(r && r.ok && r.thumbnailUrl ? r.thumbnailUrl : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function fetchLoomThumbFromBackground(clipId) {
  if (!clipId) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "FETCH_LOOM_OEMBED_THUMB", clipId: String(clipId) }, (r) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(r && r.ok && r.thumbnailUrl ? r.thumbnailUrl : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function reloadPopupReviewList() {
  const els = getPopupHomeElements();
  try {
    const [cfg, sess, listRes] = await Promise.all([
      sendMessage("MF_SUPABASE_CONFIG"),
      sendMessage("MF_SUPABASE_SESSION"),
      sendMessage("MF_CLOUD_LIST_CLIPS"),
    ]);
    const user = sess?.user ?? null;
    const rawItems = listRes?.ok && Array.isArray(listRes.items) ? listRes.items.slice() : [];
    await enrichClipThumbnails(rawItems);
    const enrichedList = { ok: listRes?.ok === true, items: rawItems };
    await writePopupCache(cfg, user, enrichedList);
    await applyHomeViewRender(els, cfg, user, enrichedList);
  } catch {
    showToast("Could not refresh list.");
  }
}

async function clearCollabLocalBindingsForItem(item) {
  const keys = collabHostKeysToTry(item.platform, item.clipId);
  try {
    await chrome.storage.local.remove(keys);
  } catch {
    /* ignore */
  }
  try {
    const curRaw = await chrome.storage.local.get("notch_shared_review");
    const cur = curRaw.notch_shared_review;
    if (!cur || typeof cur !== "object") return;
    const uid = String(cur.uid || "").trim();
    const owner = item.reviewOwnerUserId && String(item.reviewOwnerUserId).trim();
    if (
      owner &&
      uid &&
      normalizeUuidForCompare(uid) === normalizeUuidForCompare(owner) &&
      cur.platform === item.platform &&
      cur.clip === item.clipId
    ) {
      await chrome.storage.local.remove("notch_shared_review");
    }
  } catch {
    /* ignore */
  }
}

async function handleDeleteOwnReviewFromPopup(item, actionBtn) {
  const title = String(item.title || "this video").trim() || "this video";
  const confirmed = await openNpConfirm({
    title: "Delete this review?",
    message: `This removes your review for "${title}" and all notes. This cannot be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) return;
  if (actionBtn) actionBtn.disabled = true;
  try {
    const r = await sendMessage("MF_CLOUD_DELETE_CLIP", {
      platform: item.platform,
      clipId: item.clipId,
    });
    if (!r?.ok) {
      showToast("Could not delete review.");
      return;
    }
    showToast("Review deleted.");
    await reloadPopupReviewList();
  } finally {
    if (actionBtn) actionBtn.disabled = false;
  }
}

async function handleLeaveSharedReviewFromPopup(item, actionBtn) {
  const hostId = item.reviewOwnerUserId && String(item.reviewOwnerUserId).trim();
  if (!hostId) {
    showToast("Could not leave review.");
    return;
  }
  const title = String(item.title || "this review").trim() || "this review";
  const confirmed = await openNpConfirm({
    title: "Leave this shared review?",
    message: `You will lose access until you open the share link again. Leave "${title}"?`,
    confirmLabel: "Leave",
    danger: false,
  });
  if (!confirmed) return;
  if (actionBtn) actionBtn.disabled = true;
  try {
    const r = await sendMessage("MF_COLLAB_LEAVE", {
      platform: item.platform,
      clipId: item.clipId,
      hostUserId: hostId,
    });
    if (!r?.ok) {
      showToast("Could not leave review.");
      return;
    }
    await clearCollabLocalBindingsForItem(item);
    showToast("Left shared review.");
    await reloadPopupReviewList();
  } finally {
    if (actionBtn) actionBtn.disabled = false;
  }
}

async function enrichClipThumbnails(items) {
  for (const row of items) {
    if (row.thumbnailUrl) continue;
    if (row.platform === "vimeo") {
      const o = await fetchVimeoThumbFromBackground(row.clipId);
      if (!o) continue;
      row.thumbnailUrl = o;
      try {
        await sendMessage("MF_CLOUD_UPDATE_THUMB", {
          platform: row.platform,
          clipId: row.clipId,
          thumbnailUrl: o,
        });
      } catch {
        /* ignore */
      }
    } else if (row.platform === "loom") {
      const o = await fetchLoomThumbFromBackground(row.clipId);
      if (!o) continue;
      row.thumbnailUrl = o;
      try {
        await sendMessage("MF_CLOUD_UPDATE_THUMB", {
          platform: row.platform,
          clipId: row.clipId,
          thumbnailUrl: o,
        });
      } catch {
        /* ignore */
      }
    }
  }
}

function renderReviewSections(container, mine, shared) {
  container.innerHTML = "";
  function appendSection(title, sectionItems, sharedWithMe) {
    if (sectionItems.length === 0) return;
    const h = document.createElement("div");
    h.className = "np-section-label";
    h.textContent = title;
    container.appendChild(h);
    const ul = document.createElement("ul");
    ul.className = "np-dash-list";
    for (const item of sectionItems) {
      const li = document.createElement("li");
      li.className = "np-dash-li";
      const row = document.createElement("div");
      row.className = "np-dash-row";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "np-dash-card";
      btn.title = item.title;
      let thumb;
      if (item.thumbnailUrl) {
        thumb = document.createElement("img");
        thumb.className = "np-dash-thumb";
        thumb.alt = "";
        thumb.loading = "lazy";
        thumb.src = item.thumbnailUrl;
      } else {
        thumb = document.createElement("div");
        thumb.className = "np-dash-thumb np-dash-thumb--placeholder";
        thumb.setAttribute("aria-hidden", "true");
      }
      const meta = document.createElement("div");
      meta.className = "np-dash-meta";
      const badge = document.createElement("span");
      badge.className = "np-dash-platform";
      badge.textContent = item.platform;
      const t = document.createElement("span");
      t.className = "np-dash-title";
      t.textContent = item.title;
      const c = document.createElement("span");
      c.className = "np-dash-count";
      c.textContent = item.commentCount + " note" + (item.commentCount === 1 ? "" : "s");
      meta.appendChild(badge);
      meta.appendChild(t);
      meta.appendChild(c);
      btn.appendChild(thumb);
      btn.appendChild(meta);
      btn.addEventListener("click", () => void openReviewFromPopup(item, sharedWithMe));

      const action = document.createElement("button");
      action.type = "button";
      action.className = sharedWithMe ? "np-dash-action np-dash-action--leave" : "np-dash-action np-dash-action--delete";
      if (sharedWithMe) {
        action.title = "Leave shared review";
        action.setAttribute("aria-label", "Leave shared review");
        action.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>';
        action.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void handleLeaveSharedReviewFromPopup(item, action);
        });
      } else {
        action.title = "Delete review";
        action.setAttribute("aria-label", "Delete review");
        action.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
        action.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void handleDeleteOwnReviewFromPopup(item, action);
        });
      }

      row.appendChild(btn);
      row.appendChild(action);
      li.appendChild(row);
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }
  appendSection("My reviews", mine, false);
  appendSection("Shared with me", shared, true);
}

function setHeaderEmail(emailEl, email) {
  if (!emailEl) return;
  const v = String(email || "").trim();
  if (v) {
    emailEl.textContent = v;
    showEl(emailEl, true);
  } else {
    emailEl.textContent = "";
    showEl(emailEl, false);
  }
}

function setPopupSettingsButtonVisible(on) {
  showEl(document.getElementById("np-open-settings"), !!on);
}

function setPopupGateCompactLayout(on) {
  document.body.classList.toggle("np-popup-gate-only", !!on);
}

let npGateWired = false;

function setNpGateStatus(text, kind) {
  const el = document.getElementById("np-gate-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("np-gate-status-err", kind === "err");
  el.classList.toggle("np-gate-status-ok", kind === "ok");
}

function setNpGateFormBusy(busy) {
  const form = document.getElementById("np-gate-form");
  if (!form) return;
  form.querySelectorAll("button").forEach((b) => {
    b.disabled = !!busy;
  });
  form.querySelectorAll("input").forEach((inp) => {
    inp.disabled = !!busy;
  });
}

function updateNpGateCopy(supabaseConfigured) {
  const titleEl = document.getElementById("np-gate-title");
  const msgEl = document.getElementById("np-gate-msg");
  const form = document.getElementById("np-gate-form");
  if (!titleEl || !msgEl || !form) return;
  setNpGateStatus("");
  if (!supabaseConfigured) {
    titleEl.textContent = "Setup required";
    msgEl.textContent =
      "Add your Supabase URL and publishable (anon) API key to src/supabase-config.js, run npm run build, then reload this extension in chrome://extensions.";
    showEl(form, false);
  } else {
    titleEl.textContent = "Sign in to use Notch";
    msgEl.textContent = "Continue with Google or use a magic link.";
    showEl(form, true);
  }
}

function ensureNpGateWired() {
  if (npGateWired) return;
  npGateWired = true;
  document.getElementById("np-gate-google")?.addEventListener("click", () => void submitNpGateGoogleAuth());
  document.getElementById("np-gate-magic-link")?.addEventListener("click", () => void submitNpGateMagicLink());
  document.getElementById("np-gate-email")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitNpGateMagicLink();
    }
  });
}

async function submitNpGateGoogleAuth() {
  setNpGateStatus("");
  setNpGateFormBusy(true);
  try {
    const r = await sendMessage("MF_AUTH_OAUTH_GOOGLE");
    if (!r?.ok) {
      setNpGateStatus(r?.error || "Could not start Google sign-in.", "err");
      return;
    }
    setNpGateStatus("Continue in the opened Google sign-in tab.", "ok");
  } catch (e) {
    setNpGateStatus(String(e?.message || e), "err");
  } finally {
    setNpGateFormBusy(false);
  }
}

async function submitNpGateMagicLink() {
  const emailInp = document.getElementById("np-gate-email");
  const email = (emailInp?.value || "").trim();
  if (!email) {
    setNpGateStatus("Enter your email.", "err");
    return;
  }
  setNpGateStatus("");
  setNpGateFormBusy(true);
  try {
    const r = await sendMessage("MF_AUTH_MAGIC_LINK", { email });
    if (!r?.ok) {
      setNpGateStatus(r?.error || "Could not send magic link.", "err");
      return;
    }
    setNpGateStatus(r?.message || "Check your email for a login link", "ok");
  } catch (e) {
    setNpGateStatus(String(e?.message || e), "err");
  } finally {
    setNpGateFormBusy(false);
  }
}

async function runHomeView() {
  const els = getPopupHomeElements();

  showEl(els.empty, false);
  showEl(els.errBox, false);
  showEl(els.reviewsEl, false);
  showEl(els.gate, false);
  setPopupGateCompactLayout(false);

  let cache = {};
  try {
    cache = await chrome.storage.local.get([
      POPUP_CACHE_KEY_CONFIG,
      POPUP_CACHE_KEY_USER,
      POPUP_CACHE_KEY_REVIEWS,
    ]);
  } catch {
    cache = {};
  }

  if (isCompletePopupCache(cache)) {
    const cfg = cache[POPUP_CACHE_KEY_CONFIG];
    const userObj = cache[POPUP_CACHE_KEY_USER];
    const uid = String(userObj?.id || "").trim();
    const user = uid ? { id: uid, email: userObj?.email || "" } : null;
    const listRes =
      uid && cache[POPUP_CACHE_KEY_REVIEWS]
        ? cache[POPUP_CACHE_KEY_REVIEWS]
        : { ok: true, items: [] };
    showEl(els.loading, false);
    showEl(els.skeleton, false);
    const prevFp = popupHomeFingerprint(cfg, user, listRes);
    await applyHomeViewRender(els, cfg, user, listRes);
    void refreshPopupHomeFromNetwork(els, prevFp);
    return;
  }

  showEl(els.loading, false);
  showEl(els.skeleton, true);
  try {
    const [cfg, sess, listRes, getUserRes] = await Promise.all([
      sendMessage("MF_SUPABASE_CONFIG"),
      sendMessage("MF_SUPABASE_SESSION"),
      sendMessage("MF_CLOUD_LIST_CLIPS"),
      sendMessage("MF_SUPABASE_GET_USER"),
    ]);
    const user = sess?.user ?? null;
    const rawItems = listRes?.ok && Array.isArray(listRes.items) ? listRes.items.slice() : [];
    await Promise.all([enrichClipThumbnails(rawItems), writePopupSettingsCacheFromGetUser(getUserRes)]);
    const enrichedList = { ok: listRes?.ok === true, items: rawItems };
    await writePopupCache(cfg, user, enrichedList);
    await applyHomeViewRender(els, cfg, user, enrichedList);
  } catch {
    showEl(els.skeleton, false);
    showEl(els.errBox, true);
    if (els.errText) els.errText.textContent = "Something went wrong.";
    setHeaderEmail(els.emailEl, "");
    void refreshActiveTabSidebarToggleButton();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  wireSettingsFormOnce();
  wirePopupHomeChromeOnce();
  wireNpConfirmDialogOnce();
  void runHomeView().catch(() => {
    const els = getPopupHomeElements();
    showEl(els.loading, false);
    showEl(els.skeleton, false);
    showEl(els.gate, false);
    setPopupGateCompactLayout(false);
    setPopupSettingsButtonVisible(false);
    showEl(els.errBox, true);
    if (els.errText) els.errText.textContent = "Something went wrong.";
    setHeaderEmail(els.emailEl, "");
    void refreshActiveTabSidebarToggleButton();
  });
});
