(function () {
  "use strict";

  if (window !== window.top) return;

  const ACCENT = "#00E5FF";
  /** Set true to show Draw / color / save, overlay canvas, and drawing thumbnails. */
  const FEATURE_DRAWING = false;
  function notchLog() {}
  /** Must match service worker Supabase auth storageKey. */
  const SUPABASE_AUTH_STORAGE_KEY = "sb-notch-auth";
  /** Page localStorage: guest display name for shared reviews. */
  const NOTCH_GUEST_NAME_KEY = "notch_guest_name";
  /** Stable id for reaction arrays when commenting as a guest (page localStorage). */
  const NOTCH_GUEST_REACTOR_ID_KEY = "notch_guest_reactor_id";

  const STORAGE_KEYS = {
    sidebarVisible: "markframe_sidebar_visible",
    /** Panel corner: "tl" | "tr" | "bl" | "br" (physical viewport corners). */
    panelCorner: "markframe_panel_corner",
    /** Pause video once when the comment field is focused (default on; no auto-play on blur). */
    autoPauseCommentTyping: "markframe_auto_pause_comment_typing",
    /** Written by the service worker when Supabase auth changes. */
    authState: "markframe_auth_state",
    /** @deprecated legacy YouTube-only */
    dataPrefix: "markframe_video_",
    clipPrefix: "markframe_clip_",
  };
  const GLOBAL_STATE_KEYS = {
    isVisible: "isVisible",
    activePanelView: "activePanelView",
  };
  /** chrome.storage.sync — default true */
  const SYNC_KEY_AUTO_SHOW_SIDEBAR = "autoShowSidebar";
  const SESSION_KEY_SIDEBAR_HIDDEN = "notch_sidebar_hidden";
  const SESSION_KEY_SIDEBAR_POPUP_OPEN = "notch_sidebar_popup_open";
  const URL_PARAM_NOTCH_REVIEW = "notch_review";
  const PREFS_STORAGE_KEY = "notch_prefs";
  /** Toolbar popup home cache (same keys as src/popup.js). */
  const POPUP_CACHE_KEY_CONFIG = "notch_supabase_config";
  const POPUP_CACHE_KEY_USER = "notch_popup_user";
  const POPUP_CACHE_KEY_REVIEWS = "notch_popup_reviews";
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

  const CLIP_PLATFORMS = ["youtube", "vimeo", "loom", "googledrive", "dropbox"];

  function clipStorageKey(platform, clipId) {
    return STORAGE_KEYS.clipPrefix + platform + "_" + encodeURIComponent(clipId);
  }

  /** Keys for mapping a clip to a host user when reviewing as a collaborator (persists in chrome.storage.local). */
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

  async function readCollabHostUserIdForClip(clip) {
    if (!clip) return null;
    const keys = collabHostKeysToTry(clip.platform, clip.clipId);
    const o = await safeStorageLocalGet(keys);
    for (const k of keys) {
      const id = o[k];
      if (id == null || id === "") continue;
      const s = String(id).trim();
      if (s.length > 0) return s;
    }
    return null;
  }

  function normalizeUuidForCompare(u) {
    return String(u || "")
      .trim()
      .toLowerCase()
      .replace(/-/g, "");
  }

  async function setCollabHostForRedeem(platform, clipId, hostUserId) {
    const hid = String(hostUserId || "").trim();
    if (!hid) return;
    await safeStorageLocalSet({ [collabHostStorageKey(platform, clipId)]: hid });
  }

  async function clearCollabHostForClip(clip) {
    if (!clip) return;
    const keys = collabHostKeysToTry(clip.platform, clip.clipId);
    await safeStorageLocalRemove(keys);
  }

  /** Removes current user from clip_review_collaborators only; host clip_reviews data unchanged. */
  async function removeSelfAsCollaborator(platform, clipId, hostUserId) {
    const host = String(hostUserId || "").trim();
    if (!host || !platform || !clipId) return false;
    try {
      const r = await sendExtensionMessage({
        type: "MF_COLLAB_LEAVE",
        platform,
        clipId,
        hostUserId: host,
      });
      if (!r?.ok) return false;
    } catch (_) {
      return false;
    }
    await clearCollabHostForClip({ platform, clipId });
    return true;
  }

  async function clearAllCollabHostBindings() {
    const all = await safeStorageLocalGet(null);
    const removals = Object.keys(all).filter((k) => k.startsWith("markframe_collab_host_"));
    if (removals.length) await safeStorageLocalRemove(removals);
  }

  async function getCloudLoadSaveHostUserId(clip) {
    if (!clip || !isCloudActive()) return undefined;
    const hostRaw = await readCollabHostUserIdForClip(clip);
    if (!hostRaw || !String(hostRaw).trim()) return undefined;
    await refreshCloudUser(false);
    if (!state.cloudUser?.id || String(state.cloudUser.id).trim() === "") {
      await refreshCloudUser(true);
    }
    if (!isCloudActive()) return undefined;
    const myId = state.cloudUser?.id && String(state.cloudUser.id).trim();
    if (myId && normalizeUuidForCompare(hostRaw) === normalizeUuidForCompare(myId)) {
      await clearCollabHostForClip(clip);
      return undefined;
    }
    return String(hostRaw).trim();
  }

  function clipMatchesRedeemTarget(clip, platform, serverClipId) {
    if (!clip || clip.platform !== platform) return false;
    if (clip.clipId === serverClipId) return true;
    if (platform === "dropbox") return dropboxClipIdsEquivalent(clip.clipId, serverClipId);
    return false;
  }

  function readNotchGuestNameFromLocalStorage() {
    try {
      return String(localStorage.getItem(NOTCH_GUEST_NAME_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function writeNotchGuestNameToLocalStorage(name) {
    try {
      const t = String(name || "").trim();
      if (!t) localStorage.removeItem(NOTCH_GUEST_NAME_KEY);
      else localStorage.setItem(NOTCH_GUEST_NAME_KEY, t);
    } catch (_) {}
  }

  function ensureGuestReactorId() {
    try {
      let id = String(localStorage.getItem(NOTCH_GUEST_REACTOR_ID_KEY) || "").trim();
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(NOTCH_GUEST_REACTOR_ID_KEY, id);
      }
      return id;
    } catch {
      return "";
    }
  }

  function clearGuestIdentityLocalStorage() {
    try {
      localStorage.removeItem(NOTCH_GUEST_NAME_KEY);
      localStorage.removeItem(NOTCH_GUEST_REACTOR_ID_KEY);
    } catch (_) {}
  }

  /** Host binding on this clip and the signed-in user is not the host (or signed out). */
  async function isSharedCollaborationClip(clip) {
    if (!clip) return false;
    const host = await readCollabHostUserIdForClip(clip);
    if (!host) return false;
    if (!state.cloudUser?.id) return true;
    return normalizeUuidForCompare(host) !== normalizeUuidForCompare(state.cloudUser.id);
  }

  async function syncGuestSessionForClip(clip) {
    if (state.cloudUser) {
      state.guestSession = null;
      return;
    }
    if (!clip || !(await isSharedCollaborationClip(clip))) {
      state.guestSession = null;
      return;
    }
    const name = readNotchGuestNameFromLocalStorage();
    if (name) state.guestSession = { isGuest: true, guestName: name };
    else state.guestSession = null;
  }

  function isGuestSharedReviewActive() {
    return !!(state.guestSession?.isGuest && String(state.guestSession?.guestName || "").trim());
  }

  async function getGuestSharedHostUserId(clip) {
    if (!clip || !isGuestSharedReviewActive()) return "";
    return String((await readCollabHostUserIdForClip(clip)) || "").trim();
  }

  function clearGuestSharedPoll() {
    if (guestSharedPollTimer != null) {
      clearInterval(guestSharedPollTimer);
      guestSharedPollTimer = null;
    }
  }

  function startGuestSharedPoll() {
    clearGuestSharedPoll();
    guestSharedPollTimer = setInterval(() => {
      const clip = resolveClipContext();
      if (!clip || !isGuestSharedReviewActive()) return;
      void reloadGuestSharedClipQuietly(clip);
    }, 8000);
  }

  async function reloadGuestSharedClipQuietly(clip) {
    if (!clip || pendingReactionSaves > 0) return;
    const hid = await getGuestSharedHostUserId(clip);
    if (!hid) return;
    try {
      const r = await sendExtensionMessage({
        type: "MF_GUEST_CLOUD_LOAD_CLIP",
        platform: clip.platform,
        clipId: clip.clipId,
        hostUserId: hid,
      });
      if (r?.ok !== true || !r.record) return;
      const list = coerceIncomingComments(r.record);
      if (list === null) return;
      state.comments = list;
      applyOwnIdentityToLoadedComments();
      normalizeCommentsShape();
      invalidateReactionPublicNamesCache();
      renderThread();
    } catch {
      /* noop */
    }
  }

  function resetGuestInviteModalUi() {
    guestModalStep = "choice";
    if (!root) return;
    const choice = root.querySelector(".mf-guest-invite-choice");
    const namePanel = root.querySelector(".mf-guest-invite-name-panel");
    const nameInp = root.querySelector(".mf-guest-invite-name-input");
    choice?.classList.remove("mf-hidden");
    namePanel?.classList.add("mf-hidden");
    if (nameInp) nameInp.value = "";
    root.querySelector(".mf-guest-invite-error")?.classList.add("mf-hidden");
  }

  async function updateGuestInviteSubtitle(clip) {
    if (!root) return;
    const el = root.querySelector(".mf-guest-invite-subtitle");
    if (!el) return;
    if (!clip) {
      el.textContent = "";
      return;
    }
    const raw = await getClipRecordForDisplay(clip);
    el.textContent = clipDisplayTitleFromRecord(raw, clip);
  }

  function applyGuestWatchChrome() {
    if (!root) return;
    const guest = isGuestSharedReviewActive();
    root.dataset.mfGuest = guest ? "1" : "";
    root.querySelector('[data-action="copy-link"]')?.classList.toggle("mf-hidden", !!guest);
    root.querySelector('[data-action="export-pdf"]')?.classList.toggle("mf-hidden", !!guest);
    const guestFooter = root.querySelector(".mf-guest-footer-row");
    guestFooter?.classList.toggle("mf-hidden", !guest);
    const nameEl = root.querySelector(".mf-guest-footer-name");
    if (nameEl) {
      nameEl.textContent = guest ? String(state.guestSession?.guestName || "").trim() : "";
    }
  }

  function syncSettingsGuestModeSections() {
    if (!root) return;
    const guest = isGuestSharedReviewActive();
    root.querySelectorAll(".mf-settings-guest-only").forEach((el) => {
      el.classList.toggle("mf-hidden", !guest);
    });
    root.querySelectorAll(".mf-settings-signed-in-only").forEach((el) => {
      el.classList.toggle("mf-hidden", guest);
    });
    const guestNameEl = root.querySelector(".mf-settings-guest-name");
    if (guestNameEl) {
      guestNameEl.textContent = guest ? String(state.guestSession?.guestName || "").trim() : "";
    }
  }

  function canonicalClipIdForCloudLog(platform, clipId) {
    if (platform !== "dropbox" || typeof clipId !== "string") return clipId;
    const q = clipId.indexOf("?");
    return q === -1 ? clipId : clipId.slice(0, q);
  }

  function cloudSaveFailureToast(errorCode, sharedReview) {
    if (!errorCode) return "Could not save to cloud — check your connection.";
    if (errorCode === "not_authenticated") return "Cloud session expired. Sign in again.";
    if (!sharedReview) return "Could not save to cloud — check your connection.";
    if (errorCode === "invalid_host_binding") return "Shared review target missing. Re-open the review link.";
    if (errorCode === "host_row_missing")
      return "Host has no cloud row for this video yet. Ask host to add one note first.";
    if (errorCode === "rls_denied_or_no_match")
      return "Shared review write denied. Re-open the review link.";
    return "Could not save shared review to cloud.";
  }

  function buildWatchUrlForPlatform(platform, clipId) {
    if (platform === "youtube") return "https://www.youtube.com/watch?v=" + encodeURIComponent(clipId);
    if (platform === "vimeo") return "https://vimeo.com/" + encodeURIComponent(clipId);
    if (platform === "loom") return "https://www.loom.com/share/" + encodeURIComponent(clipId);
    if (platform === "googledrive")
      return "https://drive.google.com/file/d/" + encodeURIComponent(clipId) + "/view";
    if (platform === "dropbox") return buildDropboxOpenUrl(clipId);
    return "";
  }

  async function updateWatchHeaderSub(clip) {
    if (!root) return;
    const headerSub = root.querySelector(".mf-header-sub");
    if (headerSub) headerSub.textContent = "";
    const sub = root.querySelector(".mf-watch-review-owner");
    if (!sub || root.dataset.mfReviewUi !== "active") return;
    const ownerEmail = String(state.reviewOwnerEmail || "").trim();
    const myEmail = String(state.cloudUser?.email || "").trim();
    if (ownerEmail) {
      const isOwner =
        !!myEmail && myEmail.localeCompare(ownerEmail, undefined, { sensitivity: "accent" }) === 0;
      sub.textContent = isOwner ? "Review owned by you" : "Review owned by " + ownerEmail;
      return;
    }
    const myId = state.cloudUser?.id && String(state.cloudUser.id).trim();
    if (!myId || !clip) {
      sub.textContent = "";
      return;
    }
    const hostBinding = await readCollabHostUserIdForClip(clip);
    const isOwnSession =
      !hostBinding ||
      normalizeUuidForCompare(hostBinding) === normalizeUuidForCompare(myId);
    sub.textContent = isOwnSession ? "Review owned by you" : "";
  }

  function parseClipStorageKey(key) {
    const p = STORAGE_KEYS.clipPrefix;
    if (!key.startsWith(p)) return null;
    const rest = key.slice(p.length);
    const plats = [...CLIP_PLATFORMS].sort((a, b) => b.length - a.length);
    for (const plat of plats) {
      const pref = plat + "_";
      if (rest.startsWith(pref)) {
        try {
          return { platform: plat, clipId: decodeURIComponent(rest.slice(pref.length)) };
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  const MF_PARAM = "mf";
  const COMMENT_REACTION_EMOJIS = ["👍", "👀", "✅", "❤️", "🔥", "❓"];

  let root = null;
  let canvasHost = null;
  let canvas = null;
  let ctx = null;
  let videoEl = null;
  /** When true, focusing the comment field pauses playback once (no auto-resume). */
  let autoPauseWhenTypingComments = true;
  /** Drive often plays video inside a cross-origin YouTube embed iframe — bridge via postMessage. */
  const driveYtState = {
    iframe: null,
    lastTime: 0,
    handler: null,
    onLoad: null,
    pollId: null,
    mediaSurface: null,
  };
  let resizeObs = null;
  let urlCheckTimer = null;
  let settingsEscapeHandler = null;
  let pdfExportEscapeHandler = null;
  let settingsOutsideClickHandler = null;
  let settingsAvatarPendingDataUrl = null;
  let settingsAvatarExplicitClear = false;
  let settingsMenuOpenKey = "";
  let settingsChangeEmailCooldownUntil = 0;
  let settingsChangeEmailCooldownTimer = null;
  let hasSupportedClipOnPage = false;
  /** Updated each tick before applying sidebar visibility (sync + session + auto-show rules). */
  let lastSidebarVisibilityContext = {
    guestInvite: false,
    shellUnlocked: false,
    hasClip: false,
  };
  let globalPanelState = { isVisible: true, activePanelView: "main" };
  let panelDragState = null;
  let pendingReactionSaves = 0;
  /** Custom hover roster for reaction pills (native `title` delay is not controllable). */
  let reactionRosterTooltipEl = null;
  let reactionRosterTooltipShowTid = null;
  const REACTION_ROSTER_TIP_DELAY_MS = 100;
  /** Compare-normalized user id → display_name from user_public_profiles (batch-fetched). */
  let reactionPublicNameByCompareKey = new Map();
  let reactionPublicNamesFetchTid = null;
  let lastReactionPublicNamesIdsKey = "";
  let proUpgradePollTimer = null;
  let proUpgradePollDeadline = 0;
  /** Sync cache for renderThread (display name + avatar URL). */
  let cachedEffectiveDisplayName = "";
  let cachedAuthorAvatarUrl = "";
  /** Cached timestamp format — drives formatTime() for thread + PDF. */
  let cachedTimestampFormat = "0:39";
  /** Skip redundant init when DOM mutations fire but URL / clip / panel mode are unchanged (avoids panel flicker). */
  let lastTickSignature = "";
  /** At most one delayed reload per storageKey when shared-review binding exists but host row not returned yet. */
  const sharedReviewCloudReloadOnce = new Set();
  let guestSharedPollTimer = null;
  /** `"choice"` | `"name"` — guest invite modal step. */
  let guestModalStep = "choice";
  /** When true, shared unsigned user chose "Sign up" — show auth gate instead of guest modal until signed in. */
  let guestAuthRouteGate = false;
  /** Bumps on each dashboard paint; stale async completions skip DOM so concurrent renders cannot duplicate rows. */
  /** Full storage key for the clip currently loaded in the review panel (e.g. markframe_clip_youtube_…). */
  let activeClipStorageKey = null;
  /** State 1 (start review): poll until page meta title is readable or timeout. */
  const STATE1_TITLE_POLL_MAX_RETRIES = 20;
  const STATE1_TITLE_POLL_INTERVAL_MS = 500;
  let state1TitleRetryTimer = null;
  let state1TitleRetryCount = 0;
  let state1TitleRetryClipStorageKey = null;
  let canvasMountParent = null;

  let state = {
    comments: [],
    drawMode: false,
    drawColor: ACCENT,
    collapsed: false,
    drawing: false,
    lastX: 0,
    lastY: 0,
    selectedId: null,
    /** Root comment id when inline reply composer is open; null when closed. */
    replyTargetId: null,
    /** Root comment ids whose reply threads are collapsed in the thread list. */
    collapsedReplyRoots: new Set(),
    hasInk: false,
    /** True while a clip is active but user chose "All reviews" (no navigation). */
    /** When non-null, clip library reads/writes go to Supabase ({ email }). */
    cloudUser: null,
    /** Current review owner email from cloud row source-of-truth. */
    reviewOwnerEmail: "",
    /** Row owner's Supabase user id when loaded from cloud (for host moderation). */
    reviewOwnerUserId: "",
    /** Current clip review row id in Supabase (empty when unknown/local-only). */
    currentReviewId: "",
    /** `null` = show all root comments; `"complete"` | `"incomplete"` = filter thread list. */
    commentCompleteFilter: null,
    /** `{ isGuest, guestName }` while reviewing a shared link signed out; cleared when not on a shared clip. */
    guestSession: null,
    /** Signed-in owner: Supabase has no clip_reviews row for this clip yet (not collab-waiting). */
    noOwnerReviewRow: false,
  };

  let cloudAuthCacheValidUntil = 0;
  let cloudAuthCachedUser = null;
  let cachedPreferences = { ...PREFERENCE_DEFAULTS };

  function currentCloudUserId() {
    return state.cloudUser?.id && String(state.cloudUser.id).trim();
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

  async function loadCachedPreferences() {
    const got = await safeStorageLocalGet(PREFS_STORAGE_KEY);
    const prefs = normalizePreferences({ ...PREFERENCE_DEFAULTS, ...(got[PREFS_STORAGE_KEY] || {}) });
    cachedPreferences = prefs;
    return prefs;
  }

  async function saveCachedPreferences(nextPrefs) {
    const normalized = normalizePreferences({ ...PREFERENCE_DEFAULTS, ...(nextPrefs || {}) });
    cachedPreferences = normalized;
    await safeStorageLocalSet({ [PREFS_STORAGE_KEY]: normalized });
    return normalized;
  }

  async function updateCachedPreferences(patch) {
    const current = await loadCachedPreferences();
    return saveCachedPreferences({ ...current, ...(patch || {}) });
  }

  function queueSupabasePreferenceSync(nextPrefs) {
    if (!state.cloudUser?.id) return;
    void sendExtensionMessage({ type: "MF_SUPABASE_SET_PREFERENCES", preferences: nextPrefs }).catch(() => {});
  }

  async function refreshPreferencesFromSupabase() {
    if (!state.cloudUser?.id) return loadCachedPreferences();
    try {
      const r = await sendExtensionMessage({ type: "MF_SUPABASE_GET_USER" });
      const incoming = normalizePreferences(r?.user?.preferences || {});
      const merged = { ...PREFERENCE_DEFAULTS, ...incoming };
      const current = await loadCachedPreferences();
      if (JSON.stringify(current) !== JSON.stringify(merged)) {
        await saveCachedPreferences(merged);
      } else {
        cachedPreferences = merged;
      }
      return merged;
    } catch {
      return loadCachedPreferences();
    }
  }

  /** After extension reload/update, old content scripts lose the messaging port — avoid unhandled rejections everywhere. */
  function isExtensionContextInvalidated(what) {
    const m = typeof what === "string" ? what : String(what?.message ?? what ?? "");
    return m.includes("Extension context invalidated");
  }

  function sendExtensionMessage(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (r) => {
          if (chrome.runtime.lastError) {
            const le = chrome.runtime.lastError.message || "";
            if (isExtensionContextInvalidated(le)) {
              resolve(undefined);
              return;
            }
            reject(new Error(le || "sendMessage failed"));
            return;
          }
          resolve(r);
        });
      } catch (e) {
        if (isExtensionContextInvalidated(e)) {
          resolve(undefined);
          return;
        }
        reject(e);
      }
    });
  }

  /** Avoid unhandled rejections after extension reload while content script async work is in flight. */
  async function safeStorageLocalGet(keys) {
    try {
      return await chrome.storage.local.get(keys);
    } catch (e) {
      if (isExtensionContextInvalidated(e)) return {};
      throw e;
    }
  }

  async function safeStorageLocalSet(items) {
    try {
      await chrome.storage.local.set(items);
      return true;
    } catch (e) {
      if (isExtensionContextInvalidated(e)) return false;
      throw e;
    }
  }

  async function safeStorageLocalRemove(keys) {
    try {
      await chrome.storage.local.remove(keys);
    } catch (e) {
      if (isExtensionContextInvalidated(e)) return;
      throw e;
    }
  }

  async function safeStorageSyncGet(keys) {
    try {
      return await chrome.storage.sync.get(keys);
    } catch (e) {
      if (isExtensionContextInvalidated(e)) return {};
      throw e;
    }
  }

  async function refreshCloudUser(force) {
    const now = Date.now();
    if (!force && now < cloudAuthCacheValidUntil) {
      state.cloudUser = cloudAuthCachedUser;
      refreshProGatedToolbar();
      console.log("[Notch debug] refreshCloudUser result (cache hit)", state.cloudUser);
      return;
    }
    try {
      const r = await sendExtensionMessage({ type: "MF_SUPABASE_SESSION" });
      if (!r?.configured) {
        cloudAuthCachedUser = null;
        state.cloudUser = null;
        cloudAuthCacheValidUntil = 0;
      } else {
        cloudAuthCachedUser =
          r.user && (r.user.email || r.user.id)
            ? {
                email: r.user.email || "",
                id: r.user.id || "",
                plan: String(r.user.plan || "").trim().toLowerCase() === "pro" ? "pro" : "free",
                companyLogoDataUrl: normalizeCommentAvatarUrl(r.user.companyLogoDataUrl),
              }
            : null;
        state.cloudUser = cloudAuthCachedUser;
        cloudAuthCacheValidUntil = now + 45_000;
      }
    } catch {
      cloudAuthCachedUser = null;
      state.cloudUser = null;
      cloudAuthCacheValidUntil = 0;
    }
    console.log("[Notch debug] refreshCloudUser result", state.cloudUser);
    refreshProGatedToolbar();
  }

  function setUpgradeStatusMessage(text) {
    if (!root) return;
    const panel = root.querySelector(".mf-settings-section .mf-settings-upgrade-status");
    if (!panel) return;
    panel.textContent = text || "";
    panel.classList.toggle("mf-hidden", !text);
  }

  function stopProUpgradePolling() {
    if (proUpgradePollTimer) {
      clearInterval(proUpgradePollTimer);
      proUpgradePollTimer = null;
    }
    proUpgradePollDeadline = 0;
  }

  async function pollForProUpgradePlan() {
    stopProUpgradePolling();
    proUpgradePollDeadline = Date.now() + 2 * 60 * 1000;
    proUpgradePollTimer = setInterval(async () => {
      if (Date.now() >= proUpgradePollDeadline) {
        stopProUpgradePolling();
        return;
      }
      try {
        const r = await sendExtensionMessage({ type: "MF_SUPABASE_GET_USER" });
        const plan = String(r?.user?.plan || "").trim().toLowerCase();
        if (plan !== "pro") return;
        await refreshCloudUser(true);
        await refreshPreferencesFromSupabase();
        await refreshTimestampFormatCache();
        refreshProGatedToolbar();
        setUpgradeStatusMessage("");
        stopProUpgradePolling();
      } catch {
        // Keep polling until deadline; transient network/auth failures should not stop upgrade detection.
      }
    }, 3000);
  }

  async function startUpgradeCheckoutFlow() {
    setUpgradeStatusMessage("");
    let storageSession = null;
    try {
      const authBlob = await safeStorageLocalGet("sb-notch-auth");
      const raw = authBlob?.["sb-notch-auth"];
      if (typeof raw === "string") {
        storageSession = JSON.parse(raw);
      } else if (raw && typeof raw === "object") {
        storageSession = raw;
      }
    } catch {
      storageSession = null;
    }
    const userId = String(storageSession?.user?.id || "").trim();
    const email = String(storageSession?.user?.email || "").trim();
    if (!userId || !email) {
      setUpgradeStatusMessage("Please sign in first.");
      return;
    }
    try {
      const resp = await fetch("https://notch.video/.netlify/functions/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, email }),
      });
      if (!resp.ok) {
        throw new Error(String(resp.status || "checkout_failed"));
      }
      const data = await resp.json();
      const url = String(data?.url || "").trim();
      if (!url) throw new Error("missing_checkout_url");
      const opened = await sendExtensionMessage({ type: "MF_OPEN_TAB", url });
      if (!opened?.ok) {
        throw new Error(String(opened?.error || "open_tab_failed"));
      }
      void pollForProUpgradePlan();
    } catch {
      setUpgradeStatusMessage("Something went wrong. Please try again.");
    }
  }

  async function getSupabaseConfigured() {
    try {
      const cfg = await sendExtensionMessage({ type: "MF_SUPABASE_CONFIG" });
      return !!cfg?.configured;
    } catch {
      return false;
    }
  }

  async function loadAutoShowSidebarSetting() {
    try {
      const got = await safeStorageSyncGet({ [SYNC_KEY_AUTO_SHOW_SIDEBAR]: true });
      return got[SYNC_KEY_AUTO_SHOW_SIDEBAR] !== false;
    } catch {
      return true;
    }
  }

  function hasNotchReviewUrlParam() {
    try {
      return new URL(location.href).searchParams.has(URL_PARAM_NOTCH_REVIEW);
    } catch {
      return false;
    }
  }

  /**
   * Per-tab visibility: respects sessionStorage hidden, autoShowSidebar sync pref, and popup-open flag.
   * @param {boolean} baseVisible — typically globalPanelState.isVisible
   */
  async function resolveEffectiveSidebarVisible(baseVisible, opts) {
    const hasClip = opts?.hasClip === true;
    const guestInvite = opts?.guestInvite === true;
    const shellUnlocked = opts?.shellUnlocked === true;
    const autoShowSidebar = await loadAutoShowSidebarSetting();
    const sessionStorageHideKey = sessionStorage.getItem(SESSION_KEY_SIDEBAR_HIDDEN);
    const logResolve = (returnValue) => {
      console.log("[Notch debug] resolveEffectiveSidebarVisible", {
        returnValue,
        globalPanelStateIsVisible: globalPanelState.isVisible,
        baseVisible,
        sessionStorageHideKey,
        autoShowSidebar,
      });
    };
    if (guestInvite) {
      const out = !!baseVisible && hasClip;
      logResolve(out);
      return out;
    }
    if (!shellUnlocked || !hasClip) {
      logResolve(false);
      return false;
    }
    if (sessionStorageHideKey === "true" && !hasNotchReviewUrlParam()) {
      logResolve(false);
      return false;
    }
    const popupOpen = sessionStorage.getItem(SESSION_KEY_SIDEBAR_POPUP_OPEN) === "1";
    const urlForce = hasNotchReviewUrlParam();
    if (!autoShowSidebar && !popupOpen && !urlForce) {
      logResolve(false);
      return false;
    }
    const out = !!baseVisible;
    logResolve(out);
    return out;
  }

  function isCloudActive() {
    return !!state.cloudUser;
  }

  async function updateSyncBar() {
    if (!root) return;
    const syncEl = root.querySelector(".mf-header-sync-msg");
    const signOutRow = root.querySelector(".mf-settings-sign-out-row");
    if (syncEl) {
      syncEl.textContent = "";
    }
    if (state.cloudUser?.email) {
      signOutRow?.classList.remove("mf-hidden");
    } else {
      signOutRow?.classList.add("mf-hidden");
    }
  }

  function setGateStatus(text, kind) {
    if (!root) return;
    const el = root.querySelector(".mf-gate-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("mf-gate-status-err", kind === "err");
    el.classList.toggle("mf-gate-status-ok", kind === "ok");
  }

  function setGateFormBusy(busy) {
    if (!root) return;
    const form = root.querySelector(".mf-gate-form");
    if (!form) return;
    form.querySelectorAll("button").forEach((b) => {
      b.disabled = !!busy;
    });
    form.querySelectorAll("input").forEach((inp) => {
      inp.disabled = !!busy;
    });
  }

  async function submitGateGoogleAuth() {
    setGateStatus("");
    setGateFormBusy(true);
    try {
      const r = await sendExtensionMessage({ type: "MF_AUTH_OAUTH_GOOGLE" });
      if (!r?.ok) {
        setGateStatus(r?.error || "Could not start Google sign-in.", "err");
        return;
      }
      setGateStatus("Continue in the opened Google sign-in tab.", "ok");
    } catch (e) {
      setGateStatus(String(e.message || e), "err");
    } finally {
      setGateFormBusy(false);
    }
  }

  async function submitGateMagicLink() {
    if (!root) return;
    const email = (root.querySelector(".mf-gate-email") || {}).value?.trim() || "";
    if (!email) {
      setGateStatus("Enter your email.", "err");
      return;
    }
    setGateStatus("");
    setGateFormBusy(true);
    try {
      const r = await sendExtensionMessage({
        type: "MF_AUTH_MAGIC_LINK",
        email,
      });
      if (!r?.ok) {
        setGateStatus(r?.error || "Could not send magic link.", "err");
        return;
      }
      setGateStatus(r?.message || "Check your email for a login link", "ok");
    } catch (e) {
      setGateStatus(String(e.message || e), "err");
    } finally {
      setGateFormBusy(false);
    }
  }

  function updateGateCopy(supabaseConfigured) {
    if (!root) return;
    const titleEl = root.querySelector(".mf-gate-title");
    const msgEl = root.querySelector(".mf-gate-msg");
    const form = root.querySelector(".mf-gate-form");
    if (!titleEl || !msgEl || !form) return;
    if (!supabaseConfigured) {
      titleEl.textContent = "Setup required";
      msgEl.textContent =
        "Add your Supabase URL and publishable (anon) API key to src/supabase-config.js, run npm run build, then reload this extension in chrome://extensions.";
      form.classList.add("mf-hidden");
    } else {
      titleEl.textContent = "Sign in to use Notch";
      msgEl.textContent = "Continue with Google or use a magic link.";
      form.classList.remove("mf-hidden");
    }
  }

  function syncRootChromeVisibility(opts) {
    if (!root) return;
    const guestInvite = opts?.guestInvite === true;
    const unlocked = opts?.unlocked === true;
    const gate = root.querySelector(".mf-gate-pane");
    const shell = root.querySelector(".mf-app-shell");
    const guestOverlay = root.querySelector(".mf-guest-invite-overlay");
    root.dataset.mfLocked = unlocked && !guestInvite ? "" : "1";
    root.dataset.mfGuestInviteOpen = guestInvite ? "1" : "";
    if (guestInvite) {
      gate?.classList.add("mf-hidden");
      shell?.classList.add("mf-hidden");
      guestOverlay?.classList.remove("mf-hidden");
    } else if (!unlocked) {
      gate?.classList.remove("mf-hidden");
      shell?.classList.add("mf-hidden");
      guestOverlay?.classList.add("mf-hidden");
    } else {
      gate?.classList.add("mf-hidden");
      shell?.classList.remove("mf-hidden");
      guestOverlay?.classList.add("mf-hidden");
    }
  }

  function applyAppShellLocked(locked) {
    syncRootChromeVisibility({ guestInvite: false, unlocked: !locked });
  }

  function isYoutubeSite() {
    const h = location.hostname;
    return (
      h === "www.youtube.com" ||
      h === "youtube.com" ||
      h === "m.youtube.com" ||
      h === "music.youtube.com" ||
      h === "www.youtube-nocookie.com" ||
      h === "youtube-nocookie.com" ||
      h === "youtu.be"
    );
  }

  function videoIdFromYtimgUrl(url) {
    if (!url || typeof url !== "string") return null;
    const m = url.match(/\/vi\/([^/?#]+)\//);
    return m ? m[1] : null;
  }

  function stripYoutubeWatchPageTitleSuffix(raw) {
    let t = String(raw || "").trim();
    t = t.replace(/\s*[-–—]\s*YouTube\s*$/i, "").trim();
    return t;
  }

  /**
   * Watch-page metadata. Trusted path: og:url / canonical `v=` matches `expectedVideoId` → use og:title (then
   * document.title) + og:image. SPA fallback: when og tags still reference the previous video, read the live
   * title from ytd-watch-metadata h1, then document.title (`trusted: false`).
   */
  function scrapeWatchPageMetadata(expectedVideoId) {
    if (!expectedVideoId) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }

    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    let pageVid = null;
    for (const raw of [ogUrl, canonical]) {
      if (!raw) continue;
      try {
        const parsed = new URL(raw, location.href);
        const v = parsed.searchParams.get("v");
        if (v) {
          pageVid = v;
          break;
        }
      } catch (_) {}
    }

    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content");

    if (pageVid && pageVid === expectedVideoId) {
      let thumbnailUrl = null;
      let staleThumb = false;
      if (ogImage && /^https?:/i.test(ogImage)) {
        const imgVid = videoIdFromYtimgUrl(ogImage);
        if (imgVid && imgVid !== expectedVideoId) {
          staleThumb = true;
        } else {
          thumbnailUrl = ogImage;
        }
      }

      let title = stripYoutubeWatchPageTitleSuffix(ogTitle || document.title || "");
      return {
        title: title || null,
        thumbnailUrl,
        trusted: true,
        staleThumb,
      };
    }

    const h1El =
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
      document.querySelector("#title h1 yt-formatted-string");
    let spaTitle = stripYoutubeWatchPageTitleSuffix(h1El?.textContent || "");
    if (!spaTitle || isGenericDisplayTitle(spaTitle)) {
      spaTitle = stripYoutubeWatchPageTitleSuffix(document.title || "");
    }
    if (spaTitle && !isGenericDisplayTitle(spaTitle)) {
      return {
        title: spaTitle,
        thumbnailUrl: null,
        trusted: false,
        staleThumb: false,
      };
    }

    return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
  }

  function defaultYoutubeThumbnail(videoId) {
    return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
  }

  /** Vimeo CDN paths do not use the public video id; use oEmbed instead (see fetchVimeoThumbFromBackground). */
  function defaultVimeoThumbnail(_vimeoId) {
    return "";
  }

  function isVimeoSite() {
    const h = location.hostname;
    return h === "vimeo.com" || h === "www.vimeo.com";
  }

  function isVimeoPlayerHost() {
    return location.hostname === "player.vimeo.com";
  }

  function isVimeoClipHost() {
    return isVimeoSite() || isVimeoPlayerHost();
  }

  function isLoomSite() {
    const h = location.hostname;
    return h === "loom.com" || h === "www.loom.com" || /\.loom\.com$/i.test(h);
  }

  /** Loom share/embed pages only; other loom.com paths skip so no clip is resolved on those URLs. */
  function isLoomClipHost() {
    if (!isLoomSite()) return false;
    try {
      const path = new URL(location.href).pathname;
      return /\/(?:share|embed)\//i.test(path);
    } catch (_) {
      return false;
    }
  }

  function parseLoomClipIdFromPathname(pathname) {
    if (!pathname || typeof pathname !== "string") return null;
    const m = pathname.match(/\/(?:share|embed)\/([a-f0-9]{32})(?:\/|$|\?|#|\.)/i);
    return m ? m[1].toLowerCase() : null;
  }

  function parseLoomClipIdFromUrl() {
    try {
      return parseLoomClipIdFromPathname(new URL(location.href).pathname);
    } catch (_) {
      return null;
    }
  }

  function parseLoomClipIdFromDom() {
    const tryFromHref = (raw) => {
      if (!raw || typeof raw !== "string") return null;
      try {
        return parseLoomClipIdFromPathname(new URL(raw, location.href).pathname);
      } catch (_) {
        return parseLoomClipIdFromPathname(raw);
      }
    };
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    let id = tryFromHref(ogUrl);
    if (id) return id;
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    id = tryFromHref(canonical);
    if (id) return id;
    return null;
  }

  function parseLoomClipId() {
    return parseLoomClipIdFromUrl() || parseLoomClipIdFromDom();
  }

  function loomIdInUrl(urlStr, expectedId) {
    if (!urlStr || !expectedId) return false;
    const id = String(expectedId).toLowerCase();
    const s = String(urlStr).toLowerCase();
    return s.includes("/share/" + id) || s.includes("/embed/" + id);
  }

  function scrapeLoomPageMetadata(expectedId) {
    if (!expectedId) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    let trusted = false;
    for (const raw of [ogUrl, canonical]) {
      if (raw && loomIdInUrl(raw, expectedId)) {
        trusted = true;
        break;
      }
    }
    if (!trusted) {
      try {
        if (loomIdInUrl(location.href, expectedId)) trusted = true;
      } catch (_) {}
    }
    if (!trusted && parseLoomClipIdFromUrl() === expectedId) trusted = true;
    if (!trusted && parseLoomClipIdFromDom() === expectedId) trusted = true;
    if (!trusted) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    let title = (ogTitle || document.title || "").trim();
    title = title.replace(/\s*[-–—]\s*on\s+Loom\s*$/i, "").trim();
    let thumbnailUrl = null;
    if (ogImage && /^https?:/i.test(ogImage)) {
      thumbnailUrl = ogImage;
    }
    return {
      title: title || null,
      thumbnailUrl,
      trusted: true,
      staleThumb: false,
    };
  }

  function parseVimeoClipIdFromUrl() {
    try {
      const u = new URL(location.href);
      const path = u.pathname;
      const parts = path.split("/").filter(Boolean);
      if (isVimeoPlayerHost()) {
        const vi = parts.indexOf("video");
        if (vi >= 0 && parts[vi + 1] && /^\d+$/.test(parts[vi + 1])) return parts[vi + 1];
        const mPath = path.match(/\/(?:video\/)?(\d{5,})(?:\/|$)/);
        if (mPath) return mPath[1];
        const num = parts.find((p) => /^\d{5,}$/.test(p));
        if (num) return num;
        return null;
      }
      if (parts.length === 1 && /^\d+$/.test(parts[0])) return parts[0];
      const vi = parts.indexOf("video");
      if (vi >= 0 && parts[vi + 1] && /^\d+$/.test(parts[vi + 1])) return parts[vi + 1];
      const vdi = parts.indexOf("videos");
      if (vdi >= 0 && parts[vdi + 1] && /^\d+$/.test(parts[vdi + 1])) return parts[vdi + 1];
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^\d{5,}$/.test(parts[i])) return parts[i];
      }
    } catch (_) {}
    return null;
  }

  /** When the path is odd or SPA-delayed, read id from player config / meta / data attributes. */
  function parseVimeoClipIdFromDom() {
    const tryId = (raw) => {
      if (raw == null || typeof raw !== "string") return null;
      const s = raw.trim();
      if (/^\d{5,}$/.test(s)) return s;
      const m = s.match(/(\d{5,})/);
      return m ? m[1] : null;
    };
    const fromEl = (el) => {
      if (!el) return null;
      return (
        tryId(el.getAttribute?.("data-vimeo-id")) ||
        tryId(el.getAttribute?.("data-vimeo-clip-id")) ||
        tryId(el.getAttribute?.("data-clip-id"))
      );
    };
    let id = fromEl(document.getElementById("player"));
    if (id) return id;
    for (const el of document.querySelectorAll("[data-vimeo-id], [data-vimeo-clip-id]")) {
      id = fromEl(el);
      if (id) return id;
    }
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    if (ogUrl) {
      const m = ogUrl.match(/vimeo\.com\/(?:[^/]*\/)*(\d{5,})(?:[^\d]|$)/i);
      if (m) return m[1];
      const m2 = ogUrl.match(/\/video\/(\d+)/);
      if (m2) return m2[1];
    }
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    if (canonical) {
      const m = canonical.match(/vimeo\.com\/(?:[^/]*\/)*(\d{5,})(?:[^\d]|$)/i);
      if (m) return m[1];
      const m2 = canonical.match(/\/video\/(\d+)/);
      if (m2) return m2[1];
    }
    return null;
  }

  function parseVimeoClipId() {
    return parseVimeoClipIdFromUrl() || parseVimeoClipIdFromDom();
  }

  function vimeoIdInUrl(urlStr, expectedId) {
    if (!urlStr || !expectedId) return false;
    return (
      urlStr.includes(`vimeo.com/${expectedId}`) ||
      urlStr.includes(`vimeo.com/video/${expectedId}`) ||
      urlStr.includes(`player.vimeo.com/video/${expectedId}`) ||
      (urlStr.includes("player.vimeo.com") && urlStr.includes(expectedId))
    );
  }

  function scrapeVimeoPageMetadata(expectedId) {
    if (!expectedId) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    let trusted = false;
    for (const raw of [ogUrl, canonical]) {
      if (raw && vimeoIdInUrl(raw, expectedId)) {
        trusted = true;
        break;
      }
    }
    if (!trusted) {
      try {
        if (vimeoIdInUrl(location.href, expectedId)) trusted = true;
      } catch (_) {}
    }
    if (!trusted && parseVimeoClipIdFromUrl() === expectedId) trusted = true;
    if (!trusted && parseVimeoClipIdFromDom() === expectedId) trusted = true;
    if (!trusted) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    let title = (ogTitle || document.title || "").trim();
    title = title.replace(/\s*[-–—]\s*on\s+Vimeo\s*$/i, "").trim();
    let thumbnailUrl = null;
    if (ogImage && /^https?:/i.test(ogImage)) {
      thumbnailUrl = ogImage;
    }
    return {
      title: title || null,
      thumbnailUrl,
      trusted: true,
      staleThumb: false,
    };
  }

  /** Watch `?v=`, path `/watch/ID`, `/live/`, `/shorts/`, youtu.be, or embed (incl. nocookie). */
  function parseYoutubeVideoId() {
    if (!isYoutubeSite()) return null;
    try {
      const u = new URL(location.href);
      const h = location.hostname;
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
    } catch (_) {}
    return null;
  }

  /** Trusted metadata when URL path embed id matches (og:url often lacks `v=` on embeds). */
  function scrapeYoutubeEmbedMetadata(expectedVideoId) {
    if (!expectedVideoId) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    let pathVid = null;
    try {
      const m = new URL(location.href).pathname.match(/\/embed\/([A-Za-z0-9_-]+)/);
      if (m) pathVid = m[1];
    } catch (_) {}
    if (!pathVid || pathVid !== expectedVideoId) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    let thumbnailUrl = null;
    let staleThumb = false;
    if (ogImage && /^https?:/i.test(ogImage)) {
      const imgVid = videoIdFromYtimgUrl(ogImage);
      if (imgVid && imgVid !== expectedVideoId) staleThumb = true;
      else thumbnailUrl = ogImage;
    }
    let title = stripYoutubeWatchPageTitleSuffix(ogTitle || document.title || "");
    return {
      title: title || null,
      thumbnailUrl,
      trusted: true,
      staleThumb,
    };
  }

  function scrapeYoutubeClipMetadata(expectedVideoId) {
    const watchMeta = scrapeWatchPageMetadata(expectedVideoId);
    if (watchMeta.trusted || (watchMeta.title && String(watchMeta.title).trim())) {
      return watchMeta;
    }
    return scrapeYoutubeEmbedMetadata(expectedVideoId);
  }

  function findLargestVisibleVideoMinArea(minArea) {
    const videos = [...document.querySelectorAll("video")];
    let best = null;
    let bestArea = 0;
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vpW) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vpH) - Math.max(r.top, 0));
      const area = w * h;
      if (area >= minArea && area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function getYoutubeVideoElementForClip() {
    const mp = document.getElementById("movie_player");
    if (mp) {
      const v = mp.querySelector("video");
      if (v) return v;
    }
    const h5 = document.querySelector(".html5-video-player");
    if (h5) {
      const v = h5.querySelector("video");
      if (v) return v;
    }
    const inPlayer = document.querySelector("#player video, .ytp-video-container video");
    if (inPlayer) return inPlayer;
    const lone = document.querySelector("video");
    if (lone) return lone;
    return findLargestVisibleVideoMinArea(400);
  }

  function getYoutubeOverlayParentForClip() {
    const mp = document.getElementById("movie_player");
    if (mp && mp.querySelector("video")) return mp;
    const el = getYoutubeVideoElementForClip();
    if (!el) return null;
    const h5 = el.closest(".html5-video-player");
    if (h5) return h5;
    const ytp = el.closest(".ytp-video-container");
    if (ytp) return ytp;
    const pl = document.getElementById("player");
    if (pl && pl.contains(el)) return pl;
    return el.parentElement;
  }

  function resolveYoutubeClip() {
    if (!isYoutubeSite()) return null;
    const v = parseYoutubeVideoId();
    if (!v) return null;
    const storageKey = clipStorageKey("youtube", v);
    return {
      platform: "youtube",
      clipId: v,
      storageKey,
      openUrl: () => "https://www.youtube.com/watch?v=" + encodeURIComponent(v),
      getVideoElement: getYoutubeVideoElementForClip,
      getOverlayParent: getYoutubeOverlayParentForClip,
      scrapeMetadata: (id) => scrapeYoutubeClipMetadata(id),
    };
  }

  function vimeoVideoIsUsable(v) {
    if (!v || v.tagName !== "VIDEO" || v.closest("#markframe-root")) return false;
    const r = v.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  }

  function queryFirstVimeoVideo(selectors, root) {
    const base = root || document;
    for (const sel of selectors) {
      const v = base.querySelector(sel);
      if (vimeoVideoIsUsable(v)) return v;
    }
    return null;
  }

  function getVimeoVideoElementForClip() {
    const player = document.getElementById("player");
    const scopedSelectors = [
      ".vp-video-wrapper video",
      ".vp-video video",
      ".vp-telecine video",
      "video",
    ];
    if (player) {
      const v = queryFirstVimeoVideo(scopedSelectors, player);
      if (v) return v;
    }
    const global = queryFirstVimeoVideo([
      "#player .vp-video-wrapper video",
      "#player video",
      ".vp-video-wrapper video",
      ".vp-video video",
      ".vp-player video",
      ".vp-player-layout video",
      '[data-vimeo-id] video',
      "main video",
      "video",
    ]);
    if (global) return global;
    const videos = [...document.querySelectorAll("video")].filter(vimeoVideoIsUsable);
    let best = null;
    let bestArea = 0;
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vpW) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vpH) - Math.max(r.top, 0));
      const area = w * h;
      if (area >= 400 && area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function getVimeoOverlayParentForClip() {
    const vid = getVimeoVideoElementForClip();
    if (!vid) return null;
    return (
      vid.closest(".vp-video-wrapper") ||
      vid.closest(".vp-player-layout") ||
      vid.closest("#player") ||
      vid.closest(".vp-player") ||
      vid.closest(".vp-video") ||
      vid.parentElement
    );
  }

  function resolveVimeoClip() {
    if (!isVimeoClipHost()) return null;
    const id = parseVimeoClipId();
    if (!id) return null;
    const storageKey = clipStorageKey("vimeo", id);
    return {
      platform: "vimeo",
      clipId: id,
      storageKey,
      openUrl: () => "https://vimeo.com/" + encodeURIComponent(id),
      getVideoElement: getVimeoVideoElementForClip,
      getOverlayParent: getVimeoOverlayParentForClip,
      scrapeMetadata: (clipId) => scrapeVimeoPageMetadata(clipId),
    };
  }

  function loomVideoIsUsable(v) {
    if (!v || v.tagName !== "VIDEO" || v.closest("#markframe-root")) return false;
    const r = v.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  }

  function queryFirstLoomVideo(selectors, root) {
    const base = root || document;
    for (const sel of selectors) {
      const v = base.querySelector(sel);
      if (loomVideoIsUsable(v)) return v;
    }
    return null;
  }

  function getLoomVideoElementForClip() {
    const scopedSelectors = [
      '[data-testid="video-player"] video',
      ".video-player video",
      ".loom-player video",
      "main video",
      "article video",
      "video",
    ];
    const mainEl = document.querySelector("main") || document.querySelector('[role="main"]');
    if (mainEl) {
      const v = queryFirstLoomVideo(scopedSelectors, mainEl);
      if (v) return v;
    }
    const global = queryFirstLoomVideo([
      '[data-testid="video-player"] video',
      ".video-player video",
      ".loom-player video",
      "main video",
      "article video",
      "video",
    ]);
    if (global) return global;
    const videos = [...document.querySelectorAll("video")].filter(loomVideoIsUsable);
    let best = null;
    let bestArea = 0;
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vpW) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vpH) - Math.max(r.top, 0));
      const area = w * h;
      if (area >= 400 && area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function getLoomOverlayParentForClip() {
    const vid = getLoomVideoElementForClip();
    if (!vid) return null;
    return (
      vid.closest('[data-testid="video-player"]') ||
      vid.closest(".video-player") ||
      vid.closest(".loom-player") ||
      vid.closest("main") ||
      vid.closest('[role="main"]') ||
      vid.closest("article") ||
      vid.parentElement
    );
  }

  function resolveLoomClip() {
    if (!isLoomClipHost()) return null;
    const id = parseLoomClipId();
    if (!id) return null;
    const storageKey = clipStorageKey("loom", id);
    return {
      platform: "loom",
      clipId: id,
      storageKey,
      openUrl: () => "https://www.loom.com/share/" + encodeURIComponent(id),
      getVideoElement: getLoomVideoElementForClip,
      getOverlayParent: getLoomOverlayParentForClip,
      scrapeMetadata: (clipId) => scrapeLoomPageMetadata(clipId),
    };
  }

  function isGoogleDriveSite() {
    const h = location.hostname;
    return h === "drive.google.com" || h === "docs.google.com";
  }

  function parseGoogleDriveFileIdFromPathAndSearch(pathname, searchParams) {
    if (!pathname || !searchParams) return null;
    const m = pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    if (m) return m[1];
    if (pathname === "/open") {
      const id = searchParams.get("id");
      if (id && /^[a-zA-Z0-9_-]{10,}$/.test(id)) return id;
    }
    return null;
  }

  function parseGoogleDriveFileIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (u.hostname !== "drive.google.com" && u.hostname !== "docs.google.com") return null;
      return parseGoogleDriveFileIdFromPathAndSearch(u.pathname, u.searchParams);
    } catch (_) {
      return null;
    }
  }

  function parseGoogleDriveFileIdFromDom() {
    const tryUrl = (raw) => {
      if (!raw || typeof raw !== "string") return null;
      try {
        const u = new URL(raw, location.href);
        if (u.hostname !== "drive.google.com" && u.hostname !== "docs.google.com") return null;
        return parseGoogleDriveFileIdFromPathAndSearch(u.pathname, u.searchParams);
      } catch (_) {
        return null;
      }
    };
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    let id = tryUrl(ogUrl);
    if (id) return id;
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    return tryUrl(canonical);
  }

  function parseGoogleDriveFileId() {
    return parseGoogleDriveFileIdFromUrl() || parseGoogleDriveFileIdFromDom();
  }

  /** File preview / view on Drive (path contains a file id). */
  function isGoogleDriveClipHost() {
    if (!isGoogleDriveSite()) return false;
    return !!parseGoogleDriveFileId();
  }

  function driveFileIdInUrl(urlStr, expectedId) {
    if (!urlStr || !expectedId) return false;
    try {
      const u = new URL(urlStr, location.href);
      if (u.hostname !== "drive.google.com" && u.hostname !== "docs.google.com") return false;
      const fromPath = parseGoogleDriveFileIdFromPathAndSearch(u.pathname, u.searchParams);
      return fromPath === expectedId;
    } catch (_) {
      return false;
    }
  }

  /** Poster / preview images in the Drive file viewer (og:image is often missing for video). */
  function scrapeGoogleDriveViewerThumbnailDom(fileId) {
    const viewerRoot =
      document.getElementById("drive-viewer") ||
      document.querySelector(".drive-viewer-root") ||
      document.querySelector(".drive-viewer-paginated-scrollable") ||
      document.querySelector("div[role='main']");
    if (!viewerRoot) return null;
    const imgs = [...viewerRoot.querySelectorAll("img[src]")].filter((img) => {
      if (img.closest("#markframe-root")) return false;
      const s = img.getAttribute("src") || "";
      if (!/^https?:/i.test(s)) return false;
      if (/\.svg(\?|$)/i.test(s)) return false;
      if (/icon|favicon|logo/i.test(s) && !/googleusercontent|thumbnail\?/i.test(s)) return false;
      if (
        fileId &&
        !s.includes(fileId) &&
        !/googleusercontent\.com/i.test(s) &&
        !/thumbnail\?/i.test(s) &&
        !/\/d\/[a-zA-Z0-9_-]+/i.test(s)
      ) {
        return false;
      }
      return true;
    });
    let best = null;
    let bestArea = 0;
    for (const img of imgs) {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 40 || h < 40) continue;
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = img.getAttribute("src");
      }
    }
    return best && /^https?:/i.test(best) ? best : null;
  }

  function scrapeGoogleDrivePageMetadata(expectedId) {
    if (!expectedId) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    let trusted = false;
    for (const raw of [ogUrl, canonical]) {
      if (raw && driveFileIdInUrl(raw, expectedId)) {
        trusted = true;
        break;
      }
    }
    if (!trusted) {
      try {
        if (driveFileIdInUrl(location.href, expectedId)) trusted = true;
      } catch (_) {}
    }
    if (!trusted && parseGoogleDriveFileIdFromUrl() === expectedId) trusted = true;
    if (!trusted && parseGoogleDriveFileIdFromDom() === expectedId) trusted = true;
    if (!trusted) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    let title = (ogTitle || document.title || "").trim();
    title = title.replace(/\s*[-–—]\s*Google\s+Drive\s*$/i, "").trim();
    title = title.replace(/\s*[-–—]\s*Google\s+Docs\s*$/i, "").trim();
    let thumbnailUrl = null;
    if (ogImage && /^https?:/i.test(ogImage)) {
      thumbnailUrl = ogImage;
    }
    if (!thumbnailUrl) {
      thumbnailUrl = scrapeGoogleDriveViewerThumbnailDom(expectedId);
    }
    return {
      title: title || null,
      thumbnailUrl,
      trusted: true,
      staleThumb: false,
    };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Fetches Drive's thumbnail API with the user's session and returns a data URL so the
   * library preview works off drive.google.com (cross-origin <img> would not send cookies).
   */
  async function fetchGoogleDriveThumbnailDataUrl(fileId) {
    if (!fileId) return null;
    if (location.hostname !== "drive.google.com" && location.hostname !== "docs.google.com") {
      return null;
    }
    const urls = [
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w480`,
      `https://drive.google.com/thumbnail?sz=w480&id=${encodeURIComponent(fileId)}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: "include", mode: "cors" });
        if (!r.ok) continue;
        const ab = await r.arrayBuffer();
        if (ab.byteLength < 32 || ab.byteLength > 2_500_000) continue;
        const u8 = new Uint8Array(ab);
        let mime = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!mime.startsWith("image/")) {
          if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) mime = "image/jpeg";
          else if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
            mime = "image/png";
          } else if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) mime = "image/gif";
          else continue;
        }
        const blob = new Blob([ab], { type: mime });
        const dataUrl = await blobToDataUrl(blob);
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) return dataUrl;
      } catch (_) {}
    }
    return null;
  }

  function googleDriveVideoIsUsable(v) {
    if (!v || v.tagName !== "VIDEO" || v.closest("#markframe-root")) return false;
    const r = v.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  }

  /**
   * Drive's current file viewer often puts <video> inside open shadow roots; querySelector does not
   * see those nodes, which breaks screengrabs and any logic that lists document videos only.
   */
  function collectVideoElementsDeep(root) {
    const out = [];
    if (!root) return out;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.tagName === "VIDEO") out.push(node);
      const shadow = node.shadowRoot;
      if (shadow) {
        for (let c = shadow.firstElementChild; c; c = c.nextElementSibling) {
          stack.push(c);
        }
      }
      for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
        stack.push(c);
      }
    }
    return out;
  }

  function collectIframesDeep(root) {
    const iframes = [];
    if (!root) return iframes;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.tagName === "IFRAME" && !node.closest("#markframe-root")) {
        iframes.push(node);
      }
      const shadow = node.shadowRoot;
      if (shadow) {
        for (let c = shadow.firstElementChild; c; c = c.nextElementSibling) {
          stack.push(c);
        }
      }
      for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
        stack.push(c);
      }
    }
    return iframes;
  }

  /**
   * Drive often hosts the real <video> in a same-origin nested frame; the top document only sees
   * a YouTube-style embed (postMessage surface), which is not drawable on a canvas.
   */
  function collectAllGoogleDriveVideoCandidates() {
    const videos = new Set();
    function addFromBody(body) {
      if (!body) return;
      for (const v of collectVideoElementsDeep(body)) {
        videos.add(v);
      }
    }
    addFromBody(document.body);
    const seenDoc = new WeakSet();
    seenDoc.add(document);
    const frontier = collectIframesDeep(document.body).filter((f) => !f.closest("#markframe-root"));
    let steps = 0;
    while (frontier.length && steps < 80) {
      const frame = frontier.shift();
      steps++;
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch (_) {
        continue;
      }
      if (!doc?.body || seenDoc.has(doc)) continue;
      seenDoc.add(doc);
      addFromBody(doc.body);
      for (const nested of collectIframesDeep(doc.body)) {
        if (!nested.closest("#markframe-root")) {
          frontier.push(nested);
        }
      }
    }
    return [...videos];
  }

  function findGoogleDriveNativeVideo() {
    const selectors = [
      "#drive-viewer video",
      ".drive-viewer-root video",
      ".drive-viewer-paginated-scrollable video",
      'section[aria-label="Video Player"] video',
      "div[role='main'] video",
      "video",
    ];
    for (const sel of selectors) {
      let v = null;
      try {
        v = document.querySelector(sel);
      } catch (_) {
        v = null;
      }
      if (googleDriveVideoIsUsable(v)) return v;
    }
    const merged = new Set([
      ...document.querySelectorAll("video"),
      ...collectAllGoogleDriveVideoCandidates(),
    ]);
    const videos = [...merged].filter(googleDriveVideoIsUsable);
    let best = null;
    let bestArea = 0;
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;
    function videoPickArea(v) {
      const r = v.getBoundingClientRect();
      if (v.ownerDocument === document) {
        const w = Math.max(0, Math.min(r.right, vpW) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, vpH) - Math.max(r.top, 0));
        return w * h;
      }
      return Math.max(0, r.width) * Math.max(0, r.height);
    }
    function pickBest(minArea) {
      let b = null;
      let ba = 0;
      for (const v of videos) {
        const area = videoPickArea(v);
        if (area >= minArea && area > ba) {
          ba = area;
          b = v;
        }
      }
      return b;
    }
    best = pickBest(400);
    if (!best) best = pickBest(64);
    return best;
  }

  /**
   * `getBoundingClientRect()` for nodes in nested frames is in the frame's viewport, not the tab's.
   * captureVisibleTab is in top-level innerWidth × innerHeight space — translate coordinates up the iframe chain.
   */
  function elementBoundingRectInTopLevelViewport(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    const width = r.width;
    const height = r.height;
    if (width < 4 || height < 4) return null;
    let doc = el.ownerDocument;
    while (doc && doc !== document) {
      const win = doc.defaultView;
      const frame = win && win.frameElement;
      if (!frame || frame.nodeType !== Node.ELEMENT_NODE) return null;
      const fr = frame.getBoundingClientRect();
      left += fr.left;
      top += fr.top;
      doc = frame.ownerDocument;
    }
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  /** CSS viewport rectangle to crop from chrome.tabs.captureVisibleTab (Google Drive embed / DRM fallback). */
  function getGoogleDriveScreengrabCropRect() {
    const iframe = findGoogleDriveYoutubeEmbedIframe();
    if (iframe) {
      const r = elementBoundingRectInTopLevelViewport(iframe);
      if (r && r.width >= 8 && r.height >= 8) return r;
    }
    const v = findGoogleDriveNativeVideo();
    if (v) {
      const r = elementBoundingRectInTopLevelViewport(v);
      if (r && r.width >= 8 && r.height >= 8) return r;
    }
    let el = null;
    try {
      el = document.querySelector('section[aria-label="Video Player"]');
    } catch (_) {
      el = null;
    }
    if (el) {
      const r = elementBoundingRectInTopLevelViewport(el);
      if (r && r.width >= 8 && r.height >= 8) return r;
    }
    return null;
  }

  function isDriveBackedYoutubeEmbedSrc(src) {
    if (!src || typeof src !== "string") return false;
    if (!/\/embed\/?/i.test(src)) return false;
    if (/youtube\.googleapis\.com/i.test(src)) return true;
    if (!isGoogleDriveSite()) return false;
    if (/[?&]ps=docs\b/i.test(src)) return true;
    if (/post_message_origin=/i.test(src) && /drive\.google\.com/i.test(src)) return true;
    return false;
  }

  function findGoogleDriveYoutubeEmbedIframe() {
    const iframes = [...document.querySelectorAll("iframe")];
    let best = null;
    let bestArea = 0;
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;
    for (const el of iframes) {
      if (el.closest("#markframe-root")) continue;
      const src = el.getAttribute("src") || "";
      if (!isDriveBackedYoutubeEmbedSrc(src)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vpW) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vpH) - Math.max(r.top, 0));
      const area = w * h;
      if (area >= 64 && area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  function driveYtEmbedOrigin(iframe) {
    try {
      return new URL(iframe.getAttribute("src") || iframe.src, location.href).origin;
    } catch (_) {
      return "https://youtube.googleapis.com";
    }
  }

  function postToDriveYtEmbed(iframe, obj) {
    if (!iframe?.contentWindow) return;
    const payload = JSON.stringify(obj);
    try {
      iframe.contentWindow.postMessage(payload, driveYtEmbedOrigin(iframe));
    } catch (_) {
      try {
        iframe.contentWindow.postMessage(payload, "*");
      } catch (_) {}
    }
  }

  function sendDriveYtListening(iframe) {
    postToDriveYtEmbed(iframe, { event: "listening", id: 1, channel: "widget" });
  }

  function ingestDriveYtPlayerMessage(raw) {
    let data = raw;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (_) {
        return;
      }
    }
    if (!data || typeof data !== "object") return;
    const info = data.info;
    if (typeof info?.currentTime === "number") {
      driveYtState.lastTime = info.currentTime;
    }
  }

  function teardownDriveYoutubeEmbedBridge() {
    if (driveYtState.handler) {
      window.removeEventListener("message", driveYtState.handler);
      driveYtState.handler = null;
    }
    if (driveYtState.iframe && driveYtState.onLoad) {
      driveYtState.iframe.removeEventListener("load", driveYtState.onLoad);
    }
    driveYtState.onLoad = null;
    if (driveYtState.pollId != null) {
      clearInterval(driveYtState.pollId);
      driveYtState.pollId = null;
    }
    driveYtState.iframe = null;
    driveYtState.lastTime = 0;
  }

  function bindDriveYoutubeEmbedBridge(iframe) {
    if (driveYtState.iframe === iframe) {
      sendDriveYtListening(iframe);
      return;
    }
    teardownDriveYoutubeEmbedBridge();
    driveYtState.iframe = iframe;
    driveYtState.handler = (e) => {
      if (e.source !== iframe.contentWindow) return;
      ingestDriveYtPlayerMessage(e.data);
    };
    window.addEventListener("message", driveYtState.handler);
    driveYtState.onLoad = () => sendDriveYtListening(iframe);
    iframe.addEventListener("load", driveYtState.onLoad);
    sendDriveYtListening(iframe);
    driveYtState.pollId = window.setInterval(() => {
      if (!driveYtState.iframe?.contentWindow) return;
      postToDriveYtEmbed(driveYtState.iframe, {
        event: "command",
        func: "getCurrentTime",
        args: [],
      });
    }, 450);
  }

  function ensureDriveYoutubeEmbedMediaSurface() {
    if (!driveYtState.mediaSurface) {
      const surface = {
        mfDriveYoutubeEmbed: true,
        play() {
          const el = driveYtState.iframe;
          if (!el?.contentWindow) return;
          postToDriveYtEmbed(el, { event: "command", func: "playVideo", args: [] });
        },
        pause() {
          const el = driveYtState.iframe;
          if (!el?.contentWindow) return;
          postToDriveYtEmbed(el, { event: "command", func: "pauseVideo", args: [] });
        },
      };
      Object.defineProperty(surface, "currentTime", {
        get() {
          const t = driveYtState.lastTime;
          return Number.isFinite(t) ? t : 0;
        },
        set(v) {
          const el = driveYtState.iframe;
          if (!el?.contentWindow || !Number.isFinite(v)) return;
          postToDriveYtEmbed(el, { event: "command", func: "seekTo", args: [v, true] });
          driveYtState.lastTime = v;
        },
        enumerable: true,
        configurable: true,
      });
      driveYtState.mediaSurface = surface;
    }
    return driveYtState.mediaSurface;
  }

  function getDriveYoutubeEmbedMediaSurface() {
    const iframe = findGoogleDriveYoutubeEmbedIframe();
    if (!iframe) {
      teardownDriveYoutubeEmbedBridge();
      return null;
    }
    bindDriveYoutubeEmbedBridge(iframe);
    return ensureDriveYoutubeEmbedMediaSurface();
  }

  function getGoogleDriveVideoElementForClip() {
    const native = findGoogleDriveNativeVideo();
    if (native) {
      teardownDriveYoutubeEmbedBridge();
      return native;
    }
    return getDriveYoutubeEmbedMediaSurface();
  }

  function getGoogleDriveOverlayParentForClip() {
    const native = findGoogleDriveNativeVideo();
    if (native) {
      return (
        native.closest("#drive-viewer") ||
        native.closest(".drive-viewer-root") ||
        native.closest("div[role='main']") ||
        native.parentElement
      );
    }
    const iframe = findGoogleDriveYoutubeEmbedIframe();
    if (!iframe) return null;
    return (
      iframe.closest("#drive-viewer") ||
      iframe.closest(".drive-viewer-root") ||
      iframe.closest("div[role='main']") ||
      iframe.parentElement
    );
  }

  function resolveGoogleDriveClip() {
    if (!isGoogleDriveClipHost()) return null;
    const id = parseGoogleDriveFileId();
    if (!id) return null;
    const storageKey = clipStorageKey("googledrive", id);
    return {
      platform: "googledrive",
      clipId: id,
      storageKey,
      openUrl: () => "https://drive.google.com/file/d/" + encodeURIComponent(id) + "/view",
      getVideoElement: getGoogleDriveVideoElementForClip,
      getOverlayParent: getGoogleDriveOverlayParentForClip,
      scrapeMetadata: (clipId) => scrapeGoogleDrivePageMetadata(clipId),
    };
  }

  function isDropboxSiteHostname(hostname) {
    const h = hostname || "";
    return h === "dropbox.com" || h === "www.dropbox.com" || h === "m.dropbox.com";
  }

  function isDropboxSite() {
    return isDropboxSiteHostname(location.hostname);
  }

  /** Shared file preview paths (video or other); clip id comes from the URL while the player may mount later. */
  function isDropboxShareViewerPath(pathname) {
    if (!pathname || typeof pathname !== "string") return false;
    if (/^\/s\/[^/]+\/.+/i.test(pathname)) return true;
    if (/^\/scl\/fi\/[^/]+\/.+/i.test(pathname)) return true;
    // Shared-folder file links, e.g. /scl/fo/<folderToken>/<fileToken>/name.mov
    if (/^\/scl\/fo\/[^/]+\/[^/]+\/.+/i.test(pathname)) return true;
    return false;
  }

  /** Keep share-critical query; drop volatile tracking (`e`, `st`, …) so clip_id stays stable across refresh. */
  function dropboxStableQueryFromSearchParams(searchParams) {
    if (!searchParams || typeof searchParams.get !== "function") return "";
    const rlkey = searchParams.get("rlkey");
    const dl = searchParams.get("dl");
    const parts = [];
    if (rlkey) parts.push("rlkey=" + encodeURIComponent(rlkey));
    if (dl != null && dl !== "") parts.push("dl=" + encodeURIComponent(dl));
    return parts.length ? "?" + parts.join("&") : "";
  }

  /**
   * Stable clip key for Dropbox: pathname plus `rlkey` (and optional `dl`). Guests need `rlkey` on /scl/fi/… links.
   */
  function normalizeDropboxClipPath(pathname, searchParams) {
    if (!pathname) return null;
    if (!isDropboxShareViewerPath(pathname)) return null;
    return pathname + dropboxStableQueryFromSearchParams(searchParams);
  }

  function dropboxClipPathnameOnly(clipIdStr) {
    if (!clipIdStr || typeof clipIdStr !== "string") return "";
    try {
      const pathAndQuery = clipIdStr.startsWith("/")
        ? clipIdStr
        : "/" + clipIdStr.replace(/^\/+/, "");
      const u = new URL("https://www.dropbox.com" + pathAndQuery);
      return u.pathname || "";
    } catch {
      const q = clipIdStr.indexOf("?");
      return q === -1 ? clipIdStr : clipIdStr.slice(0, q);
    }
  }

  function parseDropboxClipIdFromUrlString(href) {
    if (!href || typeof href !== "string") return null;
    try {
      const u = new URL(href, location.href);
      if (!isDropboxSiteHostname(u.hostname)) return null;
      if (!isDropboxShareViewerPath(u.pathname)) return null;
      return normalizeDropboxClipPath(u.pathname, u.searchParams);
    } catch (_) {
      return null;
    }
  }

  function parseDropboxClipIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (!isDropboxSiteHostname(u.hostname)) return null;
      if (!isDropboxShareViewerPath(u.pathname)) return null;
      return normalizeDropboxClipPath(u.pathname, u.searchParams);
    } catch (_) {
      return null;
    }
  }

  function parseDropboxClipIdFromDom() {
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    let id = parseDropboxClipIdFromUrlString(ogUrl);
    if (id) return id;
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    return parseDropboxClipIdFromUrlString(canonical);
  }

  function parseDropboxClipId() {
    return parseDropboxClipIdFromUrl() || parseDropboxClipIdFromDom();
  }

  /** Normalize a stored or parsed Dropbox path+query for comparison (handles encoding variants). */
  function normalizeDropboxClipKey(clipIdStr) {
    if (!clipIdStr || typeof clipIdStr !== "string") return null;
    try {
      const pathAndQuery = clipIdStr.startsWith("/")
        ? clipIdStr
        : "/" + clipIdStr.replace(/^\/+/, "");
      const u = new URL("https://www.dropbox.com" + pathAndQuery);
      if (!isDropboxShareViewerPath(u.pathname)) return null;
      return normalizeDropboxClipPath(u.pathname, u.searchParams);
    } catch {
      return null;
    }
  }

  function dropboxClipIdsEquivalent(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const na = normalizeDropboxClipKey(a);
    const nb = normalizeDropboxClipKey(b);
    if (na && nb && na === nb) return true;
    const pa = dropboxClipPathnameOnly(a);
    const pb = dropboxClipPathnameOnly(b);
    return Boolean(pa && pb && pa === pb && isDropboxShareViewerPath(pa));
  }

  function isDropboxClipHost() {
    if (!isDropboxSite()) return false;
    return !!parseDropboxClipId();
  }

  function dropboxClipPathInUrl(urlStr, expectedClipId) {
    if (!urlStr || !expectedClipId) return false;
    const parsed = parseDropboxClipIdFromUrlString(urlStr);
    if (!parsed) return false;
    return dropboxClipPathnameOnly(parsed) === dropboxClipPathnameOnly(expectedClipId);
  }

  function scrapeDropboxPageMetadata(expectedPath) {
    if (!expectedPath) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content");
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    let trusted = false;
    for (const raw of [ogUrl, canonical]) {
      if (raw && dropboxClipPathInUrl(raw, expectedPath)) {
        trusted = true;
        break;
      }
    }
    if (!trusted) {
      try {
        const u = new URL(location.href);
        if (isDropboxSiteHostname(u.hostname) && normalizeDropboxClipPath(u.pathname, u.searchParams) === expectedPath) {
          trusted = true;
        }
      } catch (_) {}
    }
    if (!trusted && parseDropboxClipIdFromUrl() === expectedPath) trusted = true;
    if (!trusted && parseDropboxClipIdFromDom() === expectedPath) trusted = true;
    if (!trusted) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
    let title = (ogTitle || document.title || "").trim();
    title = title.replace(/\s*[-–—]\s*Dropbox\s*$/i, "").trim();
    let thumbnailUrl = null;
    if (ogImage && /^https?:/i.test(ogImage)) {
      thumbnailUrl = ogImage;
    }
    if (!thumbnailUrl) {
      const v = findDropboxNativeVideo();
      const poster = v?.getAttribute?.("poster");
      if (poster && /^https?:/i.test(poster)) thumbnailUrl = poster;
    }
    return {
      title: title || null,
      thumbnailUrl,
      trusted: true,
      staleThumb: false,
    };
  }

  function dropboxVideoIsUsable(v) {
    if (!v || v.tagName !== "VIDEO" || v.closest("#markframe-root")) return false;
    const r = v.getBoundingClientRect();
    const inFvsdk =
      !!v.closest("#fvsdk-container") ||
      !!v.closest('[data-testid="fvsdk_preview_audio_video"]') ||
      !!v.closest("[data-vjs-player]");
    const min = inFvsdk ? 2 : 8;
    return r.width >= min && r.height >= min;
  }

  function findDropboxNativeVideo() {
    const selectors = [
      "#fvsdk-container video",
      '[data-testid="fvsdk_preview_audio_video"] video',
      "[data-vjs-player] video",
      "[data-testid='preview-video'] video",
      ".mc-video-player video",
      "main video",
      "video",
    ];
    for (const sel of selectors) {
      const v = document.querySelector(sel);
      if (dropboxVideoIsUsable(v)) return v;
    }
    const videos = [...document.querySelectorAll("video")].filter(dropboxVideoIsUsable);
    let best = null;
    let bestArea = 0;
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vpW) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vpH) - Math.max(r.top, 0));
      const area = w * h;
      if (area >= 400 && area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function buildDropboxOpenUrl(clipPath) {
    if (!clipPath || typeof clipPath !== "string" || !clipPath.startsWith("/")) {
      return "https://www.dropbox.com/";
    }
    try {
      const qIdx = clipPath.indexOf("?");
      const pathOnly = qIdx === -1 ? clipPath : clipPath.slice(0, qIdx);
      const search = qIdx === -1 ? "" : clipPath.slice(qIdx);
      const segments = pathOnly
        .split("/")
        .filter(Boolean)
        .map((seg) => encodeURIComponent(decodeURIComponent(seg)));
      return "https://www.dropbox.com/" + segments.join("/") + search;
    } catch (_) {
      return "https://www.dropbox.com/";
    }
  }

  function getDropboxVideoElementForClip() {
    return findDropboxNativeVideo();
  }

  function getDropboxOverlayParentForClip() {
    const v = findDropboxNativeVideo();
    if (!v) return null;
    return (
      v.closest("#fvsdk-container") ||
      v.closest('[data-testid="fvsdk_preview_audio_video"]') ||
      v.closest("[data-vjs-player]") ||
      v.closest("[data-testid='preview-video']") ||
      v.closest(".mc-video-player") ||
      v.closest("main") ||
      v.closest("[role='main']") ||
      v.parentElement
    );
  }

  function resolveDropboxClip() {
    if (!isDropboxClipHost()) return null;
    const clipPath = parseDropboxClipId();
    if (!clipPath) return null;
    const storageKey = clipStorageKey("dropbox", clipPath);
    return {
      platform: "dropbox",
      clipId: clipPath,
      storageKey,
      openUrl: () => buildDropboxOpenUrl(clipPath),
      getVideoElement: getDropboxVideoElementForClip,
      getOverlayParent: getDropboxOverlayParentForClip,
      scrapeMetadata: (clipId) => scrapeDropboxPageMetadata(clipId),
    };
  }

  function resolveClipContext() {
    return (
      resolveYoutubeClip() ||
      resolveVimeoClip() ||
      resolveLoomClip() ||
      resolveGoogleDriveClip() ||
      resolveDropboxClip()
    );
  }

  function clipsMatch(a, b) {
    return a && b && a.platform === b.platform && a.clipId === b.clipId;
  }

  function defaultClipDisplayTitle(clip) {
    if (!clip?.platform) return "Video";
    if (clip.platform === "youtube") return "YouTube video";
    if (clip.platform === "vimeo") return "Vimeo video";
    if (clip.platform === "loom") return "Loom video";
    if (clip.platform === "googledrive") return "Google Drive file";
    if (clip.platform === "dropbox") return "Dropbox file";
    return "Video";
  }

  /** Treat as unresolved for State 1 title polling until we have a real page-specific title. */
  const GENERIC_VIDEO_DISPLAY_TITLES = new Set(
    [
      "",
      "youtube",
      "youtube video",
      "vimeo",
      "vimeo video",
      "loom",
      "loom video",
      "watch",
      "google drive file",
      "dropbox file",
      "video",
    ].map((s) => s.toLowerCase())
  );

  function isGenericDisplayTitle(str) {
    const t = String(str || "").trim().toLowerCase();
    return GENERIC_VIDEO_DISPLAY_TITLES.has(t);
  }

  /** Prefer first specific (non-placeholder) title; otherwise fall back to live then stored. */
  function preferredClipTitleCandidate(liveRaw, storedRaw) {
    const lt = liveRaw && String(liveRaw).trim() ? String(liveRaw).trim() : "";
    const st = storedRaw && String(storedRaw).trim() ? String(storedRaw).trim() : "";
    if (lt && !isGenericDisplayTitle(lt)) return lt;
    if (st && !isGenericDisplayTitle(st)) return st;
    return lt || st;
  }

  function clipDisplayTitleFromRecord(raw, clip) {
    if (!clip) return "Video";
    let title = "";
    if (clipsMatch(resolveClipContext(), clip)) {
      const meta = clip.scrapeMetadata(clip.clipId);
      if (meta.title && String(meta.title).trim()) title = String(meta.title).trim();
    }
    if (!title && raw?.title && String(raw.title).trim()) title = String(raw.title).trim();
    if (!title) title = defaultClipDisplayTitle(clip);
    return title;
  }

  async function getClipRecordForDisplay(clip) {
    await refreshCloudUser(false);
    const configured = await getSupabaseConfigured();
    if (configured && isCloudActive()) {
      const cloudHostForLoad = await getCloudLoadSaveHostUserId(clip);
      const r = await sendExtensionMessage({
        type: "MF_CLOUD_LOAD_CLIP",
        platform: clip.platform,
        clipId: clip.clipId,
        ...(cloudHostForLoad ? { hostUserId: cloudHostForLoad } : {}),
      });
      if (r?.ok === true) {
        return r.record ?? null;
      }
      return null;
    }
    if (configured && !isCloudActive()) {
      return null;
    }
    const { [clip.storageKey]: raw } = await safeStorageLocalGet(clip.storageKey);
    return raw ?? null;
  }

  async function watchTitleResolvedParts(clip) {
    const raw = await getClipRecordForDisplay(clip);
    let liveTitle = "";
    if (clipsMatch(resolveClipContext(), clip)) {
      const meta = clip.scrapeMetadata(clip.clipId);
      /** Title counts whenever non-empty (trusted og path or SPA h1/document.title fallback); `trusted` only gates stale og:image elsewhere. */
      if (meta.title && String(meta.title).trim()) liveTitle = String(meta.title).trim();
    }
    const storedTitle = raw?.title && String(raw.title).trim() ? String(raw.title).trim() : "";
    const trimmedCandidate = preferredClipTitleCandidate(liveTitle, storedTitle);
    const resolved = !!trimmedCandidate && !isGenericDisplayTitle(trimmedCandidate);
    const text = trimmedCandidate || defaultClipDisplayTitle(clip);
    console.log("watchTitleResolvedParts", {
      text,
      resolved,
      liveTitle,
      storedTitle,
      trimmedCandidate,
      clipId: clip?.clipId,
    });
    return { text, resolved };
  }

  async function refreshWatchVideoTitle(clip, opts) {
    if (!root || !clip) return;
    let title;
    let resolved;
    try {
      ({ text: title, resolved } = await watchTitleResolvedParts(clip));
    } catch (e) {
      if (isExtensionContextInvalidated(e)) return;
      throw e;
    }
    const forceStartTitleResolved = opts?.forceStartTitleResolved === true;
    const startTitleResolved = forceStartTitleResolved || resolved;

    const headerTitle = root.querySelector(".mf-watch-header-title");
    if (headerTitle) {
      headerTitle.textContent = title;
      headerTitle.setAttribute("title", title);
    }

    const startTitle = root.querySelector(".mf-start-review-title");
    /** Scoped: other `.mf-title-skeleton` nodes live under `.mf-review-loading-pane`. */
    const startSkel = root.querySelector(".mf-start-review-title-row .mf-title-skeleton");
    if (startTitle) {
      startTitle.textContent = title;
      startTitle.setAttribute("title", title);
      startTitle.classList.toggle("mf-hidden", !startTitleResolved);
    }
    if (startSkel) {
      startSkel.classList.toggle("mf-hidden", startTitleResolved);
    }
  }

  function clearState1TitleRetryPoll() {
    if (state1TitleRetryTimer != null) {
      clearTimeout(state1TitleRetryTimer);
      state1TitleRetryTimer = null;
    }
    state1TitleRetryCount = 0;
    state1TitleRetryClipStorageKey = null;
  }

  function sidebarState1StartReview(clip) {
    return (
      !!clip &&
      state.noOwnerReviewRow &&
      isCloudActive() &&
      !isGuestSharedReviewActive()
    );
  }

  /** False if this poll generation was superseded or the clip is no longer State 1 (does not clear when key mismatches — a newer poll may own the key). */
  function state1TitleRetryPollClipStillActive(clip) {
    if (!root || !clip || clip.storageKey !== state1TitleRetryClipStorageKey) return false;
    if (!sidebarState1StartReview(clip)) {
      clearState1TitleRetryPoll();
      return false;
    }
    return true;
  }

  async function pollState1TitleRetryTick(clip) {
    try {
      state1TitleRetryTimer = null;
      if (!state1TitleRetryPollClipStillActive(clip)) return;

      const parts = await watchTitleResolvedParts(clip);
      console.log("[Notch title poll] pollState1TitleRetryTick", {
        retryCount: state1TitleRetryCount,
        title: parts.text,
        resolved: parts.resolved,
      });
      if (!state1TitleRetryPollClipStillActive(clip)) return;

      if (parts.resolved) {
        await refreshWatchVideoTitle(clip);
        clearState1TitleRetryPoll();
        return;
      }
      state1TitleRetryCount++;
      if (state1TitleRetryCount >= STATE1_TITLE_POLL_MAX_RETRIES) {
        if (!state1TitleRetryPollClipStillActive(clip)) return;
        console.log("[Notch title poll] pollState1TitleRetryTick max retries", {
          retryCount: state1TitleRetryCount,
          title: parts.text,
        });
        await refreshWatchVideoTitle(clip, { forceStartTitleResolved: true });
        clearState1TitleRetryPoll();
        return;
      }
      if (!state1TitleRetryPollClipStillActive(clip)) return;
      state1TitleRetryTimer = setTimeout(() => {
        void pollState1TitleRetryTick(clip);
      }, STATE1_TITLE_POLL_INTERVAL_MS);
    } catch (e) {
      if (isExtensionContextInvalidated(e)) {
        clearState1TitleRetryPoll();
        return;
      }
      throw e;
    }
  }

  async function maybeStartState1TitleRetryPoll(clip) {
    try {
      clearState1TitleRetryPoll();
      if (!root || !clip) {
        console.log("[Notch title poll] maybeStartState1TitleRetryPoll skipped", { reason: "!root || !clip" });
        return;
      }
      if (!sidebarState1StartReview(clip)) {
        console.log("[Notch title poll] maybeStartState1TitleRetryPoll skipped", { reason: "!sidebarState1StartReview" });
        return;
      }
      const initialParts = await watchTitleResolvedParts(clip);
      console.log("[Notch title poll] maybeStartState1TitleRetryPoll", {
        retryCount: state1TitleRetryCount,
        title: initialParts.text,
        resolved: initialParts.resolved,
      });
      if (initialParts.resolved) return;
      state1TitleRetryClipStorageKey = clip.storageKey;
      state1TitleRetryCount = 0;
      void pollState1TitleRetryTick(clip);
    } catch (e) {
      if (isExtensionContextInvalidated(e)) return;
      throw e;
    }
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    if (cachedTimestampFormat === "00:00:39") {
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /** Rounded relative time for comment timestamps (minutes, hours, days). */
  function formatRelativeAgo(fromMs) {
    if (!Number.isFinite(fromMs)) return "";
    const diffMs = Date.now() - fromMs;
    if (diffMs < 0) return "";
    const m = Math.round(diffMs / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    const h = Math.round(diffMs / 3600000);
    if (h < 24) return h + "h ago";
    const d = Math.round(diffMs / 86400000);
    return d + "d ago";
  }

  function legacyYoutubeKey(youtubeId) {
    return STORAGE_KEYS.dataPrefix + youtubeId;
  }

  /** Keys in chrome.storage.local that mirror a clip row (used to clear stale cache when cloud has no row). */
  function localClipCacheKeys(clip) {
    const keys = [clip.storageKey];
    if (clip.platform === "youtube") keys.push(legacyYoutubeKey(clip.clipId));
    return keys;
  }

  async function removeLocalClipCacheKeys(clip) {
    await safeStorageLocalRemove(localClipCacheKeys(clip));
  }

  async function loadAuthorOverride() {
    const prefs = await loadCachedPreferences();
    return String(prefs.displayName || "").trim();
  }

  async function saveAuthorOverride(override) {
    const next = await updateCachedPreferences({ displayName: String(override || "").trim() });
    queueSupabasePreferenceSync(next);
  }

  async function effectiveDisplayName() {
    if (state.guestSession?.isGuest) {
      const gn = String(state.guestSession.guestName || "").trim();
      if (gn) return gn;
    }
    await refreshCloudUser(false);
    const raw = (await loadAuthorOverride()).trim();
    if (raw) return raw;
    const em = state.cloudUser?.email?.trim();
    if (em) return em;
    return "You";
  }

  async function refreshAuthorPresentationCache() {
    await refreshCloudUser(false);
    if (isGuestSharedReviewActive()) {
      cachedEffectiveDisplayName = String(state.guestSession?.guestName || "").trim() || "Guest";
      cachedAuthorAvatarUrl = "";
      return;
    }
    cachedEffectiveDisplayName = await effectiveDisplayName();
    const prefs = await loadCachedPreferences();
    cachedAuthorAvatarUrl = typeof prefs.avatar === "string" && prefs.avatar.trim() ? prefs.avatar.trim() : "";
  }

  async function loadStoredAvatar() {
    const prefs = await loadCachedPreferences();
    const v = prefs.avatar;
    return typeof v === "string" && v.trim() ? v.trim() : "";
  }

  /** Keep under Chrome storage per-item limits (~8KB JSON). */
  const AVATAR_DATA_URL_MAX_LEN = 7000;
  /** Logo is cloud-backed; allow larger payload for sharper rendering. */
  const COMPANY_LOGO_DATA_URL_MAX_LEN = 48000;

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
            reject(new Error("Image is still too large after resizing. Try a smaller photo or use a URL."));
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
      // Keep enough detail for larger settings preview and PDF usage.
      maxPx: 320,
      maxLen: COMPANY_LOGO_DATA_URL_MAX_LEN,
      mimeType: "image/webp",
      initialQuality: 0.92,
      minQuality: 0.6,
      qualityStep: 0.05,
    });
  }

  function avatarFallbackLetter(name) {
    const s = (name || "You").trim();
    if (!s) return "?";
    const cp = s.codePointAt(0);
    return String.fromCodePoint(cp).toUpperCase();
  }

  function normalizeCommentAvatarUrl(v) {
    if (typeof v !== "string") return "";
    const s = v.trim();
    if (!s) return "";
    if (s.startsWith("https://")) return s;
    if (s.startsWith("data:image/")) return s;
    return "";
  }

  function applySettingsAvatarPreview(src, fallbackLabel) {
    if (!root) return;
    const img = root.querySelector(".mf-settings-avatar-preview");
    const fb = root.querySelector(".mf-settings-avatar-preview-fallback");
    if (!img || !fb) return;
    const letter = avatarFallbackLetter(fallbackLabel);
    fb.textContent = letter;
    if (src) {
      img.classList.add("mf-hidden");
      fb.classList.remove("mf-hidden");
      img.onload = () => {
        img.classList.remove("mf-hidden");
        fb.classList.add("mf-hidden");
      };
      img.onerror = () => {
        img.classList.add("mf-hidden");
        fb.classList.remove("mf-hidden");
      };
      img.src = src;
      if (img.complete && img.naturalWidth > 0) {
        img.classList.remove("mf-hidden");
        fb.classList.add("mf-hidden");
      }
    } else {
      img.removeAttribute("src");
      img.classList.add("mf-hidden");
      fb.classList.remove("mf-hidden");
    }
  }

  function applySettingsCompanyLogoPreview(src) {
    if (!root) return;
    const btn = root.querySelector(".mf-settings-company-logo-btn");
    const img = root.querySelector(".mf-settings-company-logo-preview");
    if (!img || !btn) return;
    const applyCompanyLogoButtonSize = (aspectRatio) => {
      const clampedAspect = Math.max(0.6, Math.min(2.2, Number(aspectRatio) || 1));
      const baseHeight = 68; // 2x original 34px control
      const width = Math.max(52, Math.min(136, Math.round(baseHeight * clampedAspect)));
      btn.style.width = width + "px";
      btn.style.height = baseHeight + "px";
    };
    const normalized = normalizeCommentAvatarUrl(src);
    if (!normalized) {
      img.classList.add("mf-hidden");
      img.removeAttribute("src");
      applyCompanyLogoButtonSize(1);
      return;
    }
    img.classList.remove("mf-hidden");
    img.onload = () => {
      const w = Number(img.naturalWidth) || 1;
      const h = Number(img.naturalHeight) || 1;
      applyCompanyLogoButtonSize(w / h);
    };
    img.onerror = () => applyCompanyLogoButtonSize(1);
    img.src = normalized;
    if (img.complete && img.naturalWidth > 0) {
      applyCompanyLogoButtonSize(img.naturalWidth / Math.max(1, img.naturalHeight));
    }
  }

  async function saveCompanyLogoSetting(dataUrl) {
    const normalized = normalizeCommentAvatarUrl(dataUrl);
    if (!normalized) throw new Error("Could not use that image.");
    const next = await updateCachedPreferences({ logoDataUrl: normalized });
    queueSupabasePreferenceSync(next);
  }

  function resetSettingsAvatarFormState() {
    settingsAvatarPendingDataUrl = null;
    settingsAvatarExplicitClear = false;
    if (!root) return;
    const fileInp = root.querySelector(".mf-settings-avatar-file");
    if (fileInp) fileInp.value = "";
    const profileFile = root.querySelector(".mf-settings-profile-avatar-file");
    if (profileFile) profileFile.value = "";
  }

  function normalizeActivePanelView(v) {
    return v === "settings" ? "settings" : "main";
  }

  async function requestGlobalStatePatch(patch) {
    try {
      await sendExtensionMessage({ type: "NOTCH_SET_GLOBAL_STATE", patch });
    } catch (_) {
      // Ignore if background is unavailable; storage listener will eventually reconcile.
    }
  }

  async function openSettingsPanel(options) {
    const persistGlobal = options?.persistGlobal === true;
    if (!root) return;
    closePdfExportModal();
    const overlay = root.querySelector(".mf-settings-overlay");
    if (!overlay) return;
    if (!overlay.classList.contains("mf-hidden")) return;
    await refreshCloudUser(true);
    const s = await loadCachedPreferences();
    void refreshPreferencesFromSupabase().then((fresh) => {
      if (!root || root.dataset.mfLocked === "1") return;
      cachedTimestampFormat = fresh.timestampFormat === "long" ? "00:00:39" : "0:39";
      const posLabel = panelCornerToLabel(normalizePanelPosition(fresh.panelPosition));
      const posValue = root.querySelector(".mf-settings-panel-position-value");
      if (posValue) posValue.textContent = posLabel;
      const autoPauseCb = root.querySelector(".mf-settings-auto-pause-comments");
      if (autoPauseCb) autoPauseCb.checked = !!fresh.autoPause;
      const floatCb = root.querySelector(".mf-settings-float-panel");
      if (floatCb) floatCb.checked = !!fresh.floatPanel;
      if (root && root.dataset.mfReviewUi === "active" && root.dataset.mfLocked !== "1") renderThread();
    });
    cachedTimestampFormat = s.timestampFormat === "long" ? "00:00:39" : "0:39";
    const posLabel = panelCornerToLabel(normalizePanelPosition(s.panelPosition));
    const posValue = root.querySelector(".mf-settings-panel-position-value");
    if (posValue) posValue.textContent = posLabel;
    const autoPauseCb = root.querySelector(".mf-settings-auto-pause-comments");
    if (autoPauseCb) autoPauseCb.checked = !!s.autoPause;
    const floatCb = root.querySelector(".mf-settings-float-panel");
    if (floatCb) floatCb.checked = !!s.floatPanel;
    refreshProGatedToolbar();
    syncSettingsGuestModeSections();
    overlay.classList.remove("mf-hidden");
    overlay.setAttribute("aria-hidden", "false");
    root.classList.add("mf-settings-open");
    settingsMenuOpenKey = "";
    settingsEscapeHandler = (e) => {
      if (e.key === "Escape") {
        const pdfOv = root.querySelector(".mf-pdf-export-overlay");
        if (pdfOv && !pdfOv.classList.contains("mf-hidden")) return;
        e.preventDefault();
        e.stopPropagation();
        closeSettingsPanel({ persistGlobal: true });
      }
    };
    settingsOutsideClickHandler = (e) => {
      if (!root) return;
      const menu = e.target instanceof Element ? e.target.closest(".mf-settings-dropdown") : null;
      if (!menu) {
        root.querySelectorAll(".mf-settings-dropdown.mf-open").forEach((d) => d.classList.remove("mf-open"));
      }
    };
    document.addEventListener("keydown", settingsEscapeHandler, true);
    document.addEventListener("click", settingsOutsideClickHandler, true);
    requestAnimationFrame(() => {
      if (isGuestSharedReviewActive()) {
        const dlg = root.querySelector(".mf-settings-dialog");
        if (dlg instanceof HTMLElement) {
          try {
            dlg.focus();
          } catch (_) {}
        }
      } else {
        const focusTarget =
          root.querySelector(".mf-settings-dropdown-btn") || root.querySelector(".mf-settings-dialog");
        try {
          focusTarget?.focus();
        } catch (_) {}
      }
    });
    if (persistGlobal) {
      globalPanelState.activePanelView = "settings";
      await requestGlobalStatePatch({ activePanelView: "settings" });
    }
  }

  async function closeSettingsPanel(options) {
    const persistGlobal = options?.persistGlobal === true;
    if (!root) return;
    const overlay = root.querySelector(".mf-settings-overlay");
    if (overlay) {
      overlay.classList.add("mf-hidden");
      overlay.setAttribute("aria-hidden", "true");
    }
    root.classList.remove("mf-settings-open");
    if (settingsEscapeHandler) {
      document.removeEventListener("keydown", settingsEscapeHandler, true);
      settingsEscapeHandler = null;
    }
    if (settingsOutsideClickHandler) {
      document.removeEventListener("click", settingsOutsideClickHandler, true);
      settingsOutsideClickHandler = null;
    }
    root.querySelectorAll(".mf-settings-dropdown.mf-open").forEach((d) => d.classList.remove("mf-open"));
    if (persistGlobal) {
      globalPanelState.activePanelView = "main";
      await requestGlobalStatePatch({ activePanelView: "main" });
    }
  }

  function clearSettingsChangeEmailCooldownTimer() {
    if (settingsChangeEmailCooldownTimer) {
      window.clearInterval(settingsChangeEmailCooldownTimer);
      settingsChangeEmailCooldownTimer = null;
    }
  }

  function updateSettingsChangeEmailButton() {
    if (!root) return;
    const changeBtn = root.querySelector('[data-action="open-change-email"]');
    if (!(changeBtn instanceof HTMLButtonElement)) return;
    const baseLabel = "Change";
    const remainingMs = settingsChangeEmailCooldownUntil - Date.now();
    if (remainingMs <= 0) {
      changeBtn.textContent = baseLabel;
      const email = state.cloudUser?.email?.trim() || "";
      changeBtn.disabled = !email;
      clearSettingsChangeEmailCooldownTimer();
      return;
    }
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    changeBtn.textContent = `${baseLabel} (${remainingSeconds}s)`;
    changeBtn.disabled = true;
  }

  function startSettingsChangeEmailCooldown() {
    settingsChangeEmailCooldownUntil = Date.now() + 60 * 1000;
    updateSettingsChangeEmailButton();
    clearSettingsChangeEmailCooldownTimer();
    settingsChangeEmailCooldownTimer = window.setInterval(updateSettingsChangeEmailButton, 1000);
  }

  async function applyDisplayNameSetting() {
    if (!root) return;
    await refreshCloudUser(false);
    const previousDisplayName = cachedEffectiveDisplayName || (await effectiveDisplayName());
    const inp = root.querySelector(".mf-settings-display-name");
    if (!inp) return;
    const v = inp.value.trim();
    const email = state.cloudUser?.email?.trim() || "";
    let override = v;
    if (!v || (email && v === email)) override = "";
    await saveAuthorOverride(override);
    await refreshAuthorPresentationCache();
    await relabelOwnCommentsInActiveClip(previousDisplayName);
    invalidateReactionPublicNamesCache();
    if (root && root.dataset.mfReviewUi === "active" && root.dataset.mfLocked !== "1") renderThread();
    scheduleReactionPublicNamesRefresh();
  }

  async function handleSettingsDropdownPick(buttonEl) {
    if (!root || !(buttonEl instanceof HTMLElement)) return;
    const row = buttonEl.closest(".mf-settings-dropdown");
    if (!row) return;
    const value = String(buttonEl.getAttribute("data-value") || "");
    const target = String(row.getAttribute("data-key") || "");
    const label = String(buttonEl.textContent || value).trim();
    const valueEl = row.querySelector(".mf-settings-dropdown-value");
    if (valueEl) valueEl.textContent = label;
    row.classList.remove("mf-open");
    if (target === "panelPosition") {
      const panelPosition = normalizePanelPositionValue(value);
      const corner = normalizePanelPosition(panelPosition);
      const next = await updateCachedPreferences({ panelPosition });
      queueSupabasePreferenceSync(next);
      await safeStorageLocalSet({ [STORAGE_KEYS.panelCorner]: corner });
      applyPanelCorner(corner);
      return;
    }
  }

  async function loadGlobalPanelState() {
    const got = await safeStorageLocalGet([
      GLOBAL_STATE_KEYS.isVisible,
      GLOBAL_STATE_KEYS.activePanelView,
      STORAGE_KEYS.sidebarVisible,
    ]);
    const visibleFromLegacy = got[STORAGE_KEYS.sidebarVisible];
    /** No `isVisible` key yet (new profile): default to showing the sidebar. */
    let visible;
    if (Object.prototype.hasOwnProperty.call(got, GLOBAL_STATE_KEYS.isVisible)) {
      visible = got[GLOBAL_STATE_KEYS.isVisible] !== false;
    } else {
      visible = true;
    }
    const view = normalizeActivePanelView(got[GLOBAL_STATE_KEYS.activePanelView]);
    return { isVisible: !!visible, activePanelView: view };
  }

  /** @param {unknown} c */
  function normalizePanelCorner(c) {
    return c === "tl" || c === "tr" || c === "bl" || c === "br" ? c : "tr";
  }

  function normalizePanelPosition(pos) {
    const p = String(pos || "").trim().toLowerCase();
    if (p === "top left" || p === "top-left") return "tl";
    if (p === "top right" || p === "top-right") return "tr";
    if (p === "bottom left" || p === "bottom-left") return "bl";
    if (p === "bottom right" || p === "bottom-right") return "br";
    return normalizePanelCorner(p);
  }

  function panelCornerToLabel(corner) {
    if (corner === "tl") return "Top left";
    if (corner === "tr") return "Top right";
    if (corner === "bl") return "Bottom left";
    return "Bottom right";
  }

  function normalizeTimestampFormat(v) {
    const s = String(v || "").trim().toLowerCase();
    return v === "00:00:39" || s === "long" ? "00:00:39" : "0:39";
  }

  async function refreshTimestampFormatCache() {
    const prefs = await loadCachedPreferences();
    cachedTimestampFormat = prefs.timestampFormat === "long" ? "00:00:39" : "0:39";
  }

  function isProUser() {
    const plan = String(state.cloudUser?.plan || "").trim().toLowerCase();
    return plan === "pro";
  }

  function applyProOnlyUi() {
    if (!root) return;
    const pro = isProUser();
    root.querySelectorAll(".mf-settings-pro-disabled").forEach((el) => {
      el.classList.toggle("mf-settings-disabled", !pro);
    });
  }

  function refreshProGatedToolbar() {
    if (!root) return;
    applyProOnlyUi();
    applyGuestWatchChrome();
    root.classList.toggle("mf-user-pro", isProUser());
    updateCopyReviewLinkButtonState();
    updateExportPdfButtonState();
    updateCommentFilterToolbarUi();
  }

  function closeCommentFilterDropdown() {
    if (!root) return;
    const wrap = root.querySelector(".mf-toolbar-filter-dropdown");
    const btn = root.querySelector('[data-action="toggle-comment-filter"]');
    if (wrap) wrap.classList.remove("mf-open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function updateCommentFilterToolbarUi() {
    if (!root) return;
    const btn = root.querySelector('[data-action="toggle-comment-filter"]');
    const wrap = root.querySelector(".mf-toolbar-filter-dropdown");
    if (btn) {
      const active = state.commentCompleteFilter != null;
      btn.classList.toggle("mf-toolbar-filter-active", active);
      btn.title = active ? "Filter comments (active)" : "Filter comments";
      btn.setAttribute("aria-label", active ? "Filter comments (active)" : "Filter comments");
      if (wrap) btn.setAttribute("aria-expanded", wrap.classList.contains("mf-open") ? "true" : "false");
    }
    root.querySelectorAll(".mf-toolbar-filter-option").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const v = el.getAttribute("data-value") || "";
      el.classList.toggle("mf-active", state.commentCompleteFilter === v);
      el.setAttribute("aria-checked", state.commentCompleteFilter === v ? "true" : "false");
    });
  }

  async function loadPanelCorner() {
    const prefs = await loadCachedPreferences();
    const fromPrefs = normalizePanelPosition(prefs.panelPosition);
    if (fromPrefs) return fromPrefs;
    const local = await safeStorageLocalGet(STORAGE_KEYS.panelCorner);
    return normalizePanelCorner(local[STORAGE_KEYS.panelCorner]);
  }

  function applyPanelCorner(corner) {
    if (!root) return;
    root.dataset.mfCorner = normalizePanelCorner(corner);
  }

  /** @param {unknown} v */
  function normalizeAutoPauseCommentTyping(v) {
    return v !== false;
  }

  /** @param {unknown} v */
  function applyAutoPauseCommentTypingPref(v) {
    autoPauseWhenTypingComments = normalizeAutoPauseCommentTyping(v);
  }

  function applyFloatPanelPref(v) {
    if (!root) return;
    root.dataset.mfFloating = v ? "1" : "";
    if (!v) {
      panelDragState = null;
      root.style.left = "";
      root.style.top = "";
      root.style.right = "";
      root.style.bottom = "";
    }
  }

  function getVideoElementForCommentPause() {
    const clip = resolveClipContext();
    if (clip) {
      const el = clip.getVideoElement();
      if (el && el.isConnected) return el;
    }
    return videoEl && videoEl.isConnected ? videoEl : null;
  }

  async function applySidebarLayoutFromStorage() {
    const [gotLocal, prefs, shared] = await Promise.all([
      safeStorageLocalGet([STORAGE_KEYS.panelCorner, STORAGE_KEYS.autoPauseCommentTyping]),
      loadCachedPreferences(),
      loadGlobalPanelState(),
    ]);
    globalPanelState = shared;
    const effective = await resolveEffectiveSidebarVisible(shared.isVisible, lastSidebarVisibilityContext);
    applySidebarDomFromEffective(effective);
    if (shared.activePanelView === "settings") {
      await openSettingsPanel({ persistGlobal: false });
    } else {
      await closeSettingsPanel({ persistGlobal: false });
    }
    applyPanelCorner(normalizePanelPosition(prefs.panelPosition || gotLocal[STORAGE_KEYS.panelCorner]));
    applyAutoPauseCommentTypingPref(prefs.autoPause);
    applyFloatPanelPref(!!prefs.floatPanel);
  }

  async function setGlobalVisibility(visible) {
    globalPanelState.isVisible = !!visible;
    await requestGlobalStatePatch({ isVisible: !!visible });
    const effective = await resolveEffectiveSidebarVisible(!!visible, lastSidebarVisibilityContext);
    applySidebarDomFromEffective(effective);
  }

  /** Refetch review from Supabase and re-render watch UI (panel shown / expanded). */
  async function refreshWatchClipFromSupabase() {
    if (!root || root.dataset.mfReviewUi !== "active" || root.dataset.mfLocked === "1") return;
    await refreshCloudUser(false);
    if (!(await getSupabaseConfigured()) || !isCloudActive()) return;
    const clip = resolveClipContext();
    if (!clip) return;
    applyWatchReviewUiPhase("loading", clip);
    try {
      await loadClipData(clip);
      updateWatchChromeForReviewMode(clip);
      await mergeClipMetadata(clip);
      await refreshWatchVideoTitle(clip);
      await updateWatchHeaderSub(clip);
    } finally {
      if (root && root.dataset.mfReviewUi === "loading") {
        updateWatchChromeForReviewMode(clip);
      }
    }
    renderThread();
  }

  function applySidebarDomFromEffective(effectiveVisible) {
    const prevHidden = root ? root.classList.contains("mf-hidden") : true;
    if (root) root.classList.toggle("mf-hidden", !effectiveVisible);
    if (!FEATURE_DRAWING) {
      if (canvasHost) canvasHost.style.visibility = "hidden";
    } else if (canvasHost && !state.drawMode) {
      canvasHost.style.visibility = effectiveVisible ? "visible" : "hidden";
    }
    if (!effectiveVisible) {
      clearState1TitleRetryPoll();
    }
    if (effectiveVisible && prevHidden) {
      void (async () => {
        await refreshWatchClipFromSupabase();
        const c = resolveClipContext();
        if (c) await maybeStartState1TitleRetryPoll(c);
      })();
    }
  }

  /** Tighter panel on small viewports. */
  function applyCompactRootLayout() {
    if (!root) return;
    root.dataset.mfCompact =
      window.innerWidth < 480 || window.innerHeight < 360 ? "1" : "";
  }

  function normalizeCommentListShape(list) {
    if (!Array.isArray(list)) return;
    const ids = new Set(list.map((c) => c.id));
    for (const c of list) {
      if (c.parentId != null && c.parentId !== "" && !ids.has(String(c.parentId))) {
        delete c.parentId;
      }
    }
    for (const c of list) {
      if (typeof c.complete !== "boolean") {
        c.complete = c.reaction === "approve";
      }
      delete c.reaction;
      if (c.isGuest === true) {
        delete c.authorId;
      } else {
        const authorId = normalizeAuthorId(c.authorId);
        if (authorId) c.authorId = authorId;
        else delete c.authorId;
      }
      const av = normalizeCommentAvatarUrl(c.avatarUrl);
      if (av) c.avatarUrl = av;
      else delete c.avatarUrl;
      c.reactions = normalizeCommentReactions(c.reactions);
    }
  }

  function normalizeCommentsShape() {
    normalizeCommentListShape(state.comments);
  }

  function normalizeAuthorId(v) {
    if (typeof v !== "string") return "";
    return v.trim();
  }

  function normalizeCommentReactions(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const emoji of COMMENT_REACTION_EMOJIS) {
      const arr = raw[emoji];
      if (!Array.isArray(arr)) continue;
      const seen = new Set();
      const cleaned = [];
      for (const userId of arr) {
        const id = normalizeAuthorId(userId);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        cleaned.push(id);
      }
      if (cleaned.length) out[emoji] = cleaned;
    }
    return out;
  }

  function ensureCommentReactions(comment) {
    if (!comment || typeof comment !== "object") return {};
    comment.reactions = normalizeCommentReactions(comment.reactions);
    return comment.reactions;
  }

  /** Map compare-normalized id → display name from comment authors only (no Supabase). */
  function buildCommentAuthorDisplayNameMap() {
    const map = new Map();
    if (!Array.isArray(state.comments)) return map;
    for (const c of state.comments) {
      const aid = normalizeAuthorId(c?.authorId);
      if (!aid) continue;
      const key = normalizeUuidForCompare(aid);
      const label = String(displayNameForComment(c) || "").trim();
      if (!label) continue;
      map.set(key, label);
    }
    return map;
  }

  /** Comment authors first; `user_public_profiles` overwrites for current display names. */
  function mergedReactionDisplayNameMap() {
    const merged = buildCommentAuthorDisplayNameMap();
    for (const [k, v] of reactionPublicNameByCompareKey) {
      const nm = String(v || "").trim();
      if (nm) merged.set(k, nm);
    }
    if (isGuestSharedReviewActive()) {
      const gid = ensureGuestReactorId();
      const gn = String(state.guestSession?.guestName || "").trim();
      if (gid && gn) merged.set(normalizeUuidForCompare(gid), gn);
    }
    return merged;
  }

  function collectReactorAndAuthorUserIds() {
    const raw = new Set();
    if (!Array.isArray(state.comments)) return [];
    for (const c of state.comments) {
      const aid = normalizeAuthorId(c?.authorId);
      if (aid) raw.add(aid);
      const reactions = normalizeCommentReactions(c?.reactions);
      for (const emoji of COMMENT_REACTION_EMOJIS) {
        const arr = reactions[emoji];
        if (!Array.isArray(arr)) continue;
        for (const uid of arr) {
          const id = normalizeAuthorId(uid);
          if (id) raw.add(id);
        }
      }
    }
    return [...raw];
  }

  function invalidateReactionPublicNamesCache() {
    lastReactionPublicNamesIdsKey = "";
  }

  function scheduleReactionPublicNamesRefresh() {
    clearTimeout(reactionPublicNamesFetchTid);
    if (!currentCloudUserId()) {
      reactionPublicNameByCompareKey = new Map();
      lastReactionPublicNamesIdsKey = "";
      return;
    }
    const ids = collectReactorAndAuthorUserIds();
    const key = [...ids].sort().join("\0");
    if (key === lastReactionPublicNamesIdsKey) {
      return;
    }
    reactionPublicNamesFetchTid = setTimeout(() => {
      reactionPublicNamesFetchTid = null;
      void refreshReactionPublicNamesFromServer();
    }, 200);
  }

  async function refreshReactionPublicNamesFromServer() {
    if (!currentCloudUserId()) return;
    const ids = collectReactorAndAuthorUserIds();
    const key = [...ids].sort().join("\0");
    if (!ids.length) {
      lastReactionPublicNamesIdsKey = "";
      reactionPublicNameByCompareKey = new Map();
      return;
    }
    if (key === lastReactionPublicNamesIdsKey) return;
    try {
      const r = await sendExtensionMessage({
        type: "MF_SUPABASE_FETCH_PUBLIC_DISPLAY_NAMES",
        userIds: ids,
      });
      if (!r?.ok) return;
      const next = new Map();
      for (const [id, name] of Object.entries(r.names || {})) {
        const cmp = normalizeUuidForCompare(id);
        const nm = String(name || "").trim();
        if (cmp && nm) next.set(cmp, nm);
      }
      reactionPublicNameByCompareKey = next;
      lastReactionPublicNamesIdsKey = key;
      if (root && root.dataset.mfReviewUi === "active" && root.dataset.mfLocked !== "1") {
        renderThread();
      }
    } catch {
      /* ignore */
    }
  }

  /** Roster for a reaction pill; current user shown as "You". Names from DB + comment fallbacks. */
  function formatReactionHoverTitle(reactorIds) {
    const ids = Array.isArray(reactorIds) ? reactorIds : [];
    const myId = normalizeAuthorId(currentCloudUserId());
    const guestRid = isGuestSharedReviewActive() ? ensureGuestReactorId() : "";
    const myKey =
      myId ? normalizeUuidForCompare(myId) : guestRid ? normalizeUuidForCompare(guestRid) : "";
    const nameMap = mergedReactionDisplayNameMap();
    const seen = new Set();
    const labels = [];
    for (const rawId of ids) {
      const id = normalizeAuthorId(rawId);
      if (!id) continue;
      const key = normalizeUuidForCompare(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const label = myKey && key === myKey ? "You" : nameMap.get(key);
      if (label) labels.push(label);
    }
    labels.sort((a, b) => {
      if (a === "You") return -1;
      if (b === "You") return 1;
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
    return labels.join("\n");
  }

  function isOwnComment(comment) {
    if (comment?.isGuest === true && isGuestSharedReviewActive()) {
      const gn = String(state.guestSession?.guestName || "").trim();
      const author = String(comment?.author || "").trim();
      return !!gn && author === gn;
    }
    const uid = currentCloudUserId();
    const aid = normalizeAuthorId(comment?.authorId);
    if (uid && aid && normalizeUuidForCompare(uid) === normalizeUuidForCompare(aid)) return true;
    const author = String(comment?.author || "").trim();
    return !!author && author === cachedEffectiveDisplayName;
  }

  function displayNameForComment(comment) {
    if (isOwnComment(comment) && cachedEffectiveDisplayName) return cachedEffectiveDisplayName;
    return comment?.author || "You";
  }

  function applyOwnIdentityToLoadedComments() {
    const uid = currentCloudUserId();
    if (!uid || !Array.isArray(state.comments) || state.comments.length === 0) return;
    for (const c of state.comments) {
      if (c?.isGuest === true) continue;
      if (normalizeAuthorId(c?.authorId)) continue;
      if (String(c?.author || "").trim() === cachedEffectiveDisplayName) {
        c.authorId = uid;
      }
    }
  }

  async function relabelOwnCommentsInActiveClip(previousDisplayName) {
    const prevName = String(previousDisplayName || "").trim();
    const nextName = String(cachedEffectiveDisplayName || "").trim();
    const uid = currentCloudUserId();
    if (!Array.isArray(state.comments) || state.comments.length === 0) return;
    let changed = false;
    const nextAvatar = normalizeCommentAvatarUrl(cachedAuthorAvatarUrl);
    for (const c of state.comments) {
      const aid = normalizeAuthorId(c?.authorId);
      const byId =
        !!uid && !!aid && normalizeUuidForCompare(uid) === normalizeUuidForCompare(aid);
      const byPrevName = !aid && !!prevName && String(c?.author || "").trim() === prevName;
      if (!byId && !byPrevName) continue;
      if (uid && aid !== uid) {
        c.authorId = uid;
        changed = true;
      }
      if (nextName && c.author !== nextName) {
        c.author = nextName;
        changed = true;
      }
      if (nextAvatar) {
        if (c.avatarUrl !== nextAvatar) {
          c.avatarUrl = nextAvatar;
          changed = true;
        }
      } else if (c.avatarUrl) {
        delete c.avatarUrl;
        changed = true;
      }
    }
    if (!changed) return;
    normalizeCommentsShape();
    const clip = resolveClipContext();
    if (clip) {
      await saveClipData(clip);
    }
  }

  function coerceIncomingComments(raw) {
    if (!raw || raw.comments == null) return null;
    const v = raw.comments;
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try {
        const p = JSON.parse(v);
        return Array.isArray(p) ? p : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Write-through: persist the latest Supabase row into `markframe_clip_*` keys (and drop legacy YouTube key). */
  async function mirrorCloudRecordToLocalCache(clip, record) {
    const key = clip.storageKey;
    const payload = {
      comments: state.comments,
      updatedAt: record.updatedAt ?? Date.now(),
      title: record.title ?? null,
      thumbnailUrl: record.thumbnailUrl ?? null,
      platform: clip.platform,
      clipId: clip.clipId,
    };
    await safeStorageLocalSet({ [key]: payload });
    if (clip.platform === "youtube") {
      await safeStorageLocalRemove(legacyYoutubeKey(clip.clipId));
    }
    notchLog("loadClipData mirrored cloud row to chrome.storage.local", {
      key,
      commentCount: payload.comments.length,
    });
  }

  async function loadClipData(clip) {
    state.replyTargetId = null;
    state.collapsedReplyRoots.clear();
    state.commentCompleteFilter = null;
    closeCommentFilterDropdown();
    state.reviewOwnerEmail = "";
    state.reviewOwnerUserId = "";
    state.currentReviewId = "";
    state.noOwnerReviewRow = false;
    await refreshCloudUser(false);
    const key = clip.storageKey;
    const hostBindingRaw = await readCollabHostUserIdForClip(clip);
    const sharedReviewTarget =
      !!hostBindingRaw &&
      (!state.cloudUser?.id ||
        normalizeUuidForCompare(hostBindingRaw) !== normalizeUuidForCompare(state.cloudUser.id));
    const configured = await getSupabaseConfigured();
    const cloudActive = configured && isCloudActive();
    notchLog("loadClipData start", {
      platform: clip.platform,
      clipId: clip.clipId,
      storageKey: key,
      supabaseConfigured: configured,
      cloudActive,
      cloudUser: !!state.cloudUser,
      sharedReviewTarget,
    });

    if (cloudActive) {
      let r;
      let cloudHostForLoad = await getCloudLoadSaveHostUserId(clip);
      let hostUserIdSent = !!cloudHostForLoad;
      try {
        r = await sendExtensionMessage({
          type: "MF_CLOUD_LOAD_CLIP",
          platform: clip.platform,
          clipId: clip.clipId,
          ...(cloudHostForLoad ? { hostUserId: cloudHostForLoad } : {}),
        });
      } catch (e) {
        notchLog("loadClipData MF_CLOUD_LOAD_CLIP threw", { message: String(e?.message || e) });
        r = null;
      }
      if (r?.ok === true && r.record == null && !hostUserIdSent) {
        cloudHostForLoad = await getCloudLoadSaveHostUserId(clip);
        if (cloudHostForLoad) {
          hostUserIdSent = true;
          try {
            r = await sendExtensionMessage({
              type: "MF_CLOUD_LOAD_CLIP",
              platform: clip.platform,
              clipId: clip.clipId,
              hostUserId: cloudHostForLoad,
            });
          } catch (e) {
            notchLog("loadClipData MF_CLOUD_LOAD_CLIP retry threw", {
              message: String(e?.message || e),
            });
            r = null;
          }
        }
      }
      const cloudSummary = {
        typeofR: r === undefined ? "undefined" : r === null ? "null" : typeof r,
        ok: r?.ok,
        recordIsNull: r?.record == null,
        recordType: r?.record == null ? "none" : typeof r.record,
        recordKeys:
          r?.record && typeof r.record === "object" && !Array.isArray(r.record)
            ? Object.keys(r.record)
            : [],
        commentsType: r?.record ? typeof r.record.comments : "n/a",
        commentsIsArray: Array.isArray(r?.record?.comments),
        commentsLen: Array.isArray(r?.record?.comments) ? r.record.comments.length : "n/a",
      };
      notchLog("loadClipData cloud response", cloudSummary);
      let cloudSkipReason = "";
      if (r == null) cloudSkipReason = "no response (message failed or threw — check SW console)";
      else if (r.ok !== true) cloudSkipReason = "r.ok is not true — SW returned failure (see [Notch SW] logs)";
      else if (r.record == null)
        cloudSkipReason =
          "r.record is null — no row for this platform+clip_id for your user (compare to Supabase clip_reviews), or RLS hiding row";
      if (cloudSkipReason) notchLog("loadClipData cloud path note", cloudSkipReason);

      if (r?.ok === true) {
        if (r.record == null) {
          const collabHost = await readCollabHostUserIdForClip(clip);
          const sharedBindingActive =
            collabHost &&
            (!state.cloudUser?.id ||
              normalizeUuidForCompare(collabHost) !== normalizeUuidForCompare(state.cloudUser.id));
          if (sharedBindingActive) {
            state.noOwnerReviewRow = false;
            await removeLocalClipCacheKeys(clip);
            state.comments = [];
            normalizeCommentsShape();
            notchLog(
              "loadClipData cloud: no row — keeping shared-review host binding (retry when host row exists)",
              { key },
            );
            if (!sharedReviewCloudReloadOnce.has(key)) {
              sharedReviewCloudReloadOnce.add(key);
              setTimeout(() => {
                lastTickSignature = "";
                void tick();
              }, 500);
            }
            console.log("[Notch debug] loadClipData result", {
              rOk: r?.ok,
              rRecord: r?.record,
              noOwnerReviewRow: state.noOwnerReviewRow,
            });
            return;
          }
          await removeLocalClipCacheKeys(clip);
          await clearCollabHostForClip(clip);
          state.comments = [];
          normalizeCommentsShape();
          state.noOwnerReviewRow = true;
          notchLog("loadClipData cloud: no row — cleared local cache, empty comments", {
            key,
            sharedReviewTarget,
          });
          console.log("[Notch debug] loadClipData result", {
            rOk: r?.ok,
            rRecord: r?.record,
            noOwnerReviewRow: state.noOwnerReviewRow,
          });
          return;
        }
        const list = coerceIncomingComments(r.record);
        notchLog("loadClipData coerceIncomingComments", {
          listIsNull: list === null,
          listLength: Array.isArray(list) ? list.length : "n/a",
        });
        if (list !== null) {
          state.comments = list;
        } else {
          state.comments = [];
          notchLog(
            "loadClipData cloud: row present but comments invalid — using empty array",
            { key }
          );
        }
        applyOwnIdentityToLoadedComments();
        normalizeCommentsShape();
        state.reviewOwnerEmail = String(r.record.reviewOwnerEmail || "").trim();
        state.reviewOwnerUserId = String(r.record.reviewOwnerUserId ?? "").trim();
        state.currentReviewId = String(r.record.reviewId || "").trim();
        await mirrorCloudRecordToLocalCache(clip, r.record);
        sharedReviewCloudReloadOnce.delete(key);
        notchLog("loadClipData applied from cloud", { commentCount: state.comments.length });
        invalidateReactionPublicNamesCache();
        scheduleReactionPublicNamesRefresh();
        console.log("[Notch debug] loadClipData result", {
          rOk: r?.ok,
          rRecord: r?.record,
          noOwnerReviewRow: state.noOwnerReviewRow,
        });
        return;
      }
      state.comments = [];
      normalizeCommentsShape();
      showToast("Could not load notes from the cloud. Check your connection and try again.");
      notchLog("loadClipData cloud fetch failed — not using local clip cache");
      console.log("[Notch debug] loadClipData result", {
        rOk: r?.ok,
        rRecord: r?.record,
        noOwnerReviewRow: state.noOwnerReviewRow,
      });
      return;
    }

    if (configured && !isCloudActive()) {
      if (isGuestSharedReviewActive() && sharedReviewTarget) {
        const gh = String(hostBindingRaw || "").trim();
        let r = null;
        try {
          r = await sendExtensionMessage({
            type: "MF_GUEST_CLOUD_LOAD_CLIP",
            platform: clip.platform,
            clipId: clip.clipId,
            hostUserId: gh,
          });
        } catch (e) {
          notchLog("loadClipData MF_GUEST_CLOUD_LOAD_CLIP threw", { message: String(e?.message || e) });
        }
        if (r?.ok === true && r.record != null) {
          const list = coerceIncomingComments(r.record);
          if (list !== null) {
            state.comments = list;
          } else {
            state.comments = [];
          }
          applyOwnIdentityToLoadedComments();
          normalizeCommentsShape();
          state.reviewOwnerEmail = "";
          state.reviewOwnerUserId = String(r.record.reviewOwnerUserId ?? "").trim();
          state.currentReviewId = String(r.record.reviewId || "").trim();
          await mirrorCloudRecordToLocalCache(clip, r.record);
          sharedReviewCloudReloadOnce.delete(key);
          invalidateReactionPublicNamesCache();
          scheduleReactionPublicNamesRefresh();
          notchLog("loadClipData guest cloud ok", { commentCount: state.comments.length });
          console.log("[Notch debug] loadClipData result", {
            rOk: r?.ok,
            rRecord: r?.record,
            noOwnerReviewRow: state.noOwnerReviewRow,
          });
          return;
        }
        if (r?.ok === true && r.record == null) {
          await removeLocalClipCacheKeys(clip);
          state.comments = [];
          normalizeCommentsShape();
          if (!sharedReviewCloudReloadOnce.has(key)) {
            sharedReviewCloudReloadOnce.add(key);
            setTimeout(() => {
              lastTickSignature = "";
              void tick();
            }, 500);
          }
          console.log("[Notch debug] loadClipData result", {
            rOk: r?.ok,
            rRecord: r?.record,
            noOwnerReviewRow: state.noOwnerReviewRow,
          });
          return;
        }
        state.comments = [];
        normalizeCommentsShape();
        showToast("Could not load this shared review. Check your connection.");
        console.log("[Notch debug] loadClipData result", {
          rOk: r?.ok,
          rRecord: r?.record,
          noOwnerReviewRow: state.noOwnerReviewRow,
        });
        return;
      }
      state.comments = [];
      normalizeCommentsShape();
      notchLog("loadClipData: Supabase configured but not signed in — skip local clip cache");
      console.log("[Notch debug] loadClipData result", {
        rOk: undefined,
        rRecord: undefined,
        noOwnerReviewRow: state.noOwnerReviewRow,
      });
      return;
    }

    let { [key]: raw } = await safeStorageLocalGet(key);
    if (!raw && clip.platform === "youtube") {
      const leg = legacyYoutubeKey(clip.clipId);
      const got = await safeStorageLocalGet(leg);
      raw = got[leg];
      if (raw && coerceIncomingComments(raw)) {
        await safeStorageLocalSet({ [key]: raw });
      }
    }
    const list = coerceIncomingComments(raw);
    notchLog("loadClipData local path (no cloud project)", {
      hadLocalRow: !!raw,
      listIsNull: list === null,
      listLength: Array.isArray(list) ? list.length : list ? "non-array-truthy" : 0,
    });
    if (list) {
      state.comments = list;
      applyOwnIdentityToLoadedComments();
      normalizeCommentsShape();
    } else {
      state.comments = [];
    }
    invalidateReactionPublicNamesCache();
    scheduleReactionPublicNamesRefresh();
    notchLog("loadClipData end (local)", { commentCount: state.comments.length });
    console.log("[Notch debug] loadClipData result", {
      rOk: undefined,
      rRecord: undefined,
      noOwnerReviewRow: state.noOwnerReviewRow,
    });
  }

  /**
   * Persist clip review: Supabase first when the project is configured and the user is signed in;
   * only then mirror to chrome.storage.local (write-through cache). Returns false if cloud save was required but failed.
   * @param {{ comments?: unknown[] }} [options] If `comments` is set, uses it instead of `state.comments` (no optimistic UI).
   */
  async function saveClipData(clip, options) {
    const commentsPayload = options?.comments != null ? options.comments : state.comments;
    const hasExplicitCommentsPayload = options?.comments != null;
    const isLikelyNewComment = hasExplicitCommentsPayload && commentsPayload.length > state.comments.length;
    if (!Array.isArray(commentsPayload)) {
      notchLog("saveClipData abort: comments not an array");
      return false;
    }

    const key = clip.storageKey;
    const { [key]: prev } = await safeStorageLocalGet(key);
    let title = prev?.title ?? null;
    let thumbnailUrl = prev?.thumbnailUrl ?? null;
    const cur = resolveClipContext();
    if (clipsMatch(cur, clip)) {
      const meta = clip.scrapeMetadata(clip.clipId);
      if (meta.title) title = meta.title;
      if (meta.thumbnailUrl) thumbnailUrl = meta.thumbnailUrl;
      else if (meta.trusted && meta.staleThumb) thumbnailUrl = null;
    }
    if (clip.platform === "vimeo" && !thumbnailUrl) {
      const o = await fetchVimeoThumbFromBackground(clip.clipId);
      if (o) thumbnailUrl = o;
    }
    if (clip.platform === "loom" && !thumbnailUrl) {
      const o = await fetchLoomThumbFromBackground(clip.clipId);
      if (o) thumbnailUrl = o;
    }
    if (clip.platform === "googledrive" && clipsMatch(cur, clip) && !thumbnailUrl) {
      const o = await fetchGoogleDriveThumbnailDataUrl(clip.clipId);
      if (o) thumbnailUrl = o;
    }

    const payload = {
      comments: commentsPayload,
      updatedAt: Date.now(),
      title,
      thumbnailUrl,
      platform: clip.platform,
      clipId: clip.clipId,
    };

    const configured = await getSupabaseConfigured();
    const cloudActive = configured && isCloudActive();

    if (cloudActive) {
      try {
        const hostBindingRaw = await readCollabHostUserIdForClip(clip);
        const cloudHostForSave = await getCloudLoadSaveHostUserId(clip);
        const sharedReview =
          !!hostBindingRaw &&
          (!state.cloudUser?.id ||
            normalizeUuidForCompare(hostBindingRaw) !== normalizeUuidForCompare(state.cloudUser.id));
        const canonicalClipId = canonicalClipIdForCloudLog(clip.platform, clip.clipId);
        notchLog("saveClipData cloud upsert", {
          platform: clip.platform,
          clipId: clip.clipId,
          canonicalClipId,
          commentCount: commentsPayload.length,
          collabHost: !!cloudHostForSave,
          sharedReview,
        });
        if (sharedReview && !cloudHostForSave) {
          notchLog("saveClipData shared target unresolved", {
            platform: clip.platform,
            canonicalClipId,
            hostBindingRaw: String(hostBindingRaw || ""),
          });
          showToast("Shared review target missing. Re-open the review link.");
          return false;
        }
        const r = await sendExtensionMessage({
          type: "MF_CLOUD_SAVE_CLIP",
          platform: clip.platform,
          clipId: clip.clipId,
          comments: commentsPayload,
          title,
          thumbnailUrl,
          ...(cloudHostForSave ? { hostUserId: cloudHostForSave } : {}),
        });
        const errCode = r?.error ? String(r.error) : "";
        const result = {
          ok: r?.ok === true,
          error: errCode || null,
          sharedReview,
          hostUserId: cloudHostForSave || null,
          reviewId: typeof r?.reviewId === "string" ? r.reviewId.trim() : "",
        };
        notchLog("saveClipData cloud result", {
          ok: result.ok,
          typeofR: r == null ? "null" : typeof r,
          error: result.error,
          sharedReview: result.sharedReview,
          hostUserId: result.hostUserId,
          reviewId: result.reviewId || null,
          platform: clip.platform,
          canonicalClipId,
        });
        if (!result.ok) {
          showToast(cloudSaveFailureToast(errCode, sharedReview));
          return false;
        }
        if (result.reviewId) {
          state.currentReviewId = result.reviewId;
        }
        // Fire-and-forget shared-review notifications after a successful cloud save.
        if (result.sharedReview && result.hostUserId && result.reviewId && isLikelyNewComment) {
          let storageSession = null;
          try {
            const authBlob = await safeStorageLocalGet(SUPABASE_AUTH_STORAGE_KEY);
            const raw = authBlob?.[SUPABASE_AUTH_STORAGE_KEY];
            if (typeof raw === "string") storageSession = JSON.parse(raw);
            else if (raw && typeof raw === "object") storageSession = raw;
          } catch {
            storageSession = null;
          }
          const sessionUserId = String(storageSession?.user?.id || "").trim();
          if (sessionUserId) {
            const newComment = commentsPayload[commentsPayload.length - 1];
            if (newComment) {
              void fetch("https://notch.video/.netlify/functions/notify-comment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  reviewId: result.reviewId,
                  newComment: {
                    id: newComment.id,
                    ts: newComment.ts,
                    text: newComment.text,
                    author: newComment.author,
                    authorId: newComment.authorId,
                    parentId: newComment.parentId || null,
                  },
                }),
              }).catch(() => {});
            }
          }
        }
      } catch (e) {
        notchLog("saveClipData cloud exception", String(e?.message || e));
        showToast("Could not save to cloud — check your connection.");
        return false;
      }
      await safeStorageLocalSet({ [key]: payload });
      notchLog("saveClipData mirrored to chrome.storage.local after cloud ok", {
        key,
        commentCount: payload.comments.length,
      });
      void safeStorageLocalRemove(["notch_popup_reviews"]);
      return true;
    }

    if (configured && !isCloudActive()) {
      if (isGuestSharedReviewActive()) {
        const hostBindingRaw = await readCollabHostUserIdForClip(clip);
        const gh = String(hostBindingRaw || "").trim();
        const sharedReview =
          !!hostBindingRaw &&
          (!state.cloudUser?.id ||
            normalizeUuidForCompare(hostBindingRaw) !== normalizeUuidForCompare(state.cloudUser.id));
        if (!sharedReview || !gh) {
          showToast("Shared review target missing. Re-open the review link.");
          return false;
        }
        try {
          const r = await sendExtensionMessage({
            type: "MF_GUEST_CLOUD_SAVE_CLIP",
            platform: clip.platform,
            clipId: clip.clipId,
            hostUserId: gh,
            comments: commentsPayload,
            title,
            thumbnailUrl,
          });
          if (r?.ok !== true) {
            const err = String(r?.error || "");
            showToast(cloudSaveFailureToast(err, true));
            return false;
          }
          if (r?.reviewId) state.currentReviewId = String(r.reviewId).trim();
        } catch (e) {
          notchLog("saveClipData guest exception", String(e?.message || e));
          showToast("Could not save — check your connection.");
          return false;
        }
        await safeStorageLocalSet({ [key]: payload });
        void safeStorageLocalRemove(["notch_popup_reviews"]);
        return true;
      }
      showToast("Sign in to save notes to the cloud.");
      return false;
    }

    state.currentReviewId = "";
    await safeStorageLocalSet({ [key]: payload });
    notchLog("saveClipData local-only (no Supabase project)", {
      key,
      commentCount: payload.comments.length,
    });
    return true;
  }

  /** Dashboard row shape for popup list (mirrors src/sw-cloud.js `rowToDashboardItem`). */
  function buildPopupDashboardItemFromClip(clip, row) {
    const platform = clip.platform;
    const clipId = clip.clipId;
    const storageKey = clip.storageKey;
    const comments = Array.isArray(row?.comments) ? row.comments : [];
    let thumb =
      row?.thumbnailUrl && String(row.thumbnailUrl).trim() ? String(row.thumbnailUrl).trim() : null;
    if (platform === "youtube" && thumb) {
      const m = thumb.match(/\/vi\/([^/?#]+)\//);
      const thumbVid = m ? m[1] : null;
      if (thumbVid && thumbVid !== clipId) thumb = null;
    }
    const title =
      row?.title && String(row.title).trim() ? String(row.title).trim() : clipId || "Video";
    const defaultThumb =
      platform === "youtube" && clipId
        ? "https://i.ytimg.com/vi/" + encodeURIComponent(clipId) + "/hqdefault.jpg"
        : platform === "googledrive" && clipId
          ? "https://drive.google.com/thumbnail?id=" + encodeURIComponent(clipId) + "&sz=w320"
          : "";
    const openUrl = typeof clip.openUrl === "function" ? clip.openUrl() : "";
    const updatedAt = Number(row?.updatedAt);
    return {
      storageKey,
      platform,
      clipId,
      title,
      thumbnailUrl: thumb || defaultThumb || "",
      commentCount: comments.length,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      openUrl,
      reviewOwnerUserId: currentCloudUserId() || null,
    };
  }

  /**
   * After creating a review, repopulate popup cache. `saveClipData` clears `notch_popup_reviews` on cloud save,
   * so pass the previous `{ ok, items }` snapshot taken before that save to preserve existing rows.
   */
  async function mergeNewReviewIntoPopupReviewsCache(clip, prevReviewsCacheEntry) {
    if (!clip || !isCloudActive()) return;
    await refreshCloudUser(false);
    const uid = currentCloudUserId();
    if (!uid) return;

    const { [clip.storageKey]: row } = await safeStorageLocalGet(clip.storageKey);
    const item = buildPopupDashboardItemFromClip(clip, row || {});

    let items = [];
    if (prevReviewsCacheEntry?.ok === true && Array.isArray(prevReviewsCacheEntry.items)) {
      items = prevReviewsCacheEntry.items.filter(
        (i) => !(i.platform === item.platform && i.clipId === item.clipId)
      );
    }
    items.unshift(item);

    const prevRaw = await safeStorageLocalGet([POPUP_CACHE_KEY_CONFIG, POPUP_CACHE_KEY_USER]);
    let cfgEntry = prevRaw[POPUP_CACHE_KEY_CONFIG];
    if (!cfgEntry || typeof cfgEntry !== "object" || typeof cfgEntry.configured !== "boolean") {
      const cfg = await sendExtensionMessage({ type: "MF_SUPABASE_CONFIG" });
      cfgEntry = {
        ok: true,
        configured: !!cfg?.configured,
        url: String(cfg?.url || ""),
      };
    }
    let userEntry = prevRaw[POPUP_CACHE_KEY_USER];
    if (!userEntry || typeof userEntry !== "object") {
      userEntry = { id: uid, email: String(state.cloudUser?.email || "") };
    } else {
      userEntry = {
        id: String(userEntry.id || uid || "").trim() || uid,
        email: String(userEntry.email ?? state.cloudUser?.email ?? ""),
      };
    }

    await safeStorageLocalSet({
      [POPUP_CACHE_KEY_CONFIG]: cfgEntry,
      [POPUP_CACHE_KEY_USER]: userEntry,
      [POPUP_CACHE_KEY_REVIEWS]: { ok: true, items },
    });

    void sendExtensionMessage({ type: "NOTCH_POPUP_REVIEWS_UPDATED" }).catch(() => {});
  }

  /** After a reaction is saved to Supabase: notify comment author on shared reviews (fire-and-forget). */
  function queueNotifyReactionAfterSave(clip, comment, emoji, isAddingReaction) {
    if (!isAddingReaction || !clip || !comment || !COMMENT_REACTION_EMOJIS.includes(emoji)) return;
    void (async () => {
      await refreshCloudUser(false);
      if (!state.cloudUser?.id) return;
      const reactorId = normalizeAuthorId(currentCloudUserId());
      if (!reactorId) return;
      const hostBindingRaw = await readCollabHostUserIdForClip(clip);
      const sharedReview =
        !!hostBindingRaw &&
        (!state.cloudUser?.id ||
          normalizeUuidForCompare(hostBindingRaw) !== normalizeUuidForCompare(state.cloudUser.id));
      if (!sharedReview) return;
      const reviewId = String(state.currentReviewId || "").trim();
      if (!reviewId) return;
      const authorId = normalizeAuthorId(comment.authorId);
      if (!authorId || normalizeUuidForCompare(authorId) === normalizeUuidForCompare(reactorId)) return;
      const prefs = await loadCachedPreferences();
      const reactorName =
        String(prefs.displayName || "").trim() || String(state.cloudUser?.email || "").trim() || "Someone";
      const { [clip.storageKey]: raw } = await safeStorageLocalGet(clip.storageKey);
      const videoTitle = clipDisplayTitleFromRecord(raw, clip);
      void fetch("https://notch.video/.netlify/functions/notify-comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notificationType: "reaction",
          reviewId,
          emoji,
          reactorName,
          reactorId: state.cloudUser.id,
          comment: {
            id: comment.id,
            ts: comment.ts,
            text: comment.text,
            authorId: comment.authorId,
          },
          videoTitle,
        }),
      }).catch(() => {});
    })();
  }

  async function mergeClipMetadata(clip) {
    await refreshCloudUser(false);
    const key = clip.storageKey;
    const configured = await getSupabaseConfigured();
    const cloudActive = configured && isCloudActive();

    let prev = null;
    if (cloudActive) {
      const cloudHostForLoad = await getCloudLoadSaveHostUserId(clip);
      const r = await sendExtensionMessage({
        type: "MF_CLOUD_LOAD_CLIP",
        platform: clip.platform,
        clipId: clip.clipId,
        ...(cloudHostForLoad ? { hostUserId: cloudHostForLoad } : {}),
      });
      if (r?.ok !== true || !r.record) return;
      prev = r.record;
    } else if (configured && !isCloudActive()) {
      return;
    } else {
      const got = await safeStorageLocalGet(key);
      prev = got[key];
    }

    const prevComments = coerceIncomingComments(prev);
    if (!prev || !prevComments || prevComments.length === 0) return;
    const cur = resolveClipContext();
    if (!clipsMatch(cur, clip)) return;
    const meta = clip.scrapeMetadata(clip.clipId);
    if (!meta.trusted) return;
    const nextTitle = meta.title || prev.title || null;
    let nextThumb = prev.thumbnailUrl || null;
    if (meta.thumbnailUrl) nextThumb = meta.thumbnailUrl;
    else if (meta.staleThumb) nextThumb = null;
    if (clip.platform === "vimeo" && !nextThumb) {
      const o = await fetchVimeoThumbFromBackground(clip.clipId);
      if (o) nextThumb = o;
    }
    if (clip.platform === "loom" && !nextThumb) {
      const o = await fetchLoomThumbFromBackground(clip.clipId);
      if (o) nextThumb = o;
    }
    if (clip.platform === "googledrive" && !nextThumb) {
      const o = await fetchGoogleDriveThumbnailDataUrl(clip.clipId);
      if (o) nextThumb = o;
    }
    if (nextTitle === prev.title && nextThumb === prev.thumbnailUrl) return;
    const next = {
      ...prev,
      comments: prevComments,
      title: nextTitle,
      thumbnailUrl: nextThumb,
      updatedAt: Date.now(),
      platform: clip.platform,
      clipId: clip.clipId,
    };
    delete next.customTitle;

    if (cloudActive) {
      try {
        const cloudHostForSave = await getCloudLoadSaveHostUserId(clip);
        const r = await sendExtensionMessage({
          type: "MF_CLOUD_SAVE_CLIP",
          platform: clip.platform,
          clipId: clip.clipId,
          comments: prevComments,
          title: nextTitle,
          thumbnailUrl: nextThumb,
          ...(cloudHostForSave ? { hostUserId: cloudHostForSave } : {}),
        });
        if (!r?.ok) {
          notchLog("mergeClipMetadata cloud failed", {
            platform: clip.platform,
            canonicalClipId: canonicalClipIdForCloudLog(clip.platform, clip.clipId),
            error: r?.error ? String(r.error) : null,
            collabHost: !!cloudHostForSave,
          });
          showToast("Could not update video details in the cloud.");
          return;
        }
      } catch (e) {
        showToast("Could not update video details in the cloud.");
        return;
      }
    }

    await safeStorageLocalSet({ [key]: next });
  }

  function defaultLoomThumbnail(_loomId) {
    return "";
  }

  function defaultGoogleDriveThumbnail(fileId) {
    if (!fileId) return "";
    return "https://drive.google.com/thumbnail?id=" + encodeURIComponent(fileId) + "&sz=w320";
  }

  function defaultThumbForPlatform(platform, clipId) {
    if (platform === "youtube") return defaultYoutubeThumbnail(clipId);
    if (platform === "vimeo") return defaultVimeoThumbnail(clipId);
    if (platform === "loom") return defaultLoomThumbnail(clipId);
    if (platform === "googledrive") return defaultGoogleDriveThumbnail(clipId);
    if (platform === "dropbox") return "";
    return "";
  }

  function fetchVimeoThumbFromBackground(clipId) {
    if (!clipId) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "FETCH_VIMEO_OEMBED_THUMB", clipId: String(clipId) },
          (r) => {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(r && r.ok && r.thumbnailUrl ? r.thumbnailUrl : null);
          }
        );
      } catch {
        resolve(null);
      }
    });
  }

  function fetchLoomThumbFromBackground(clipId) {
    if (!clipId) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "FETCH_LOOM_OEMBED_THUMB", clipId: String(clipId) },
          (r) => {
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(r && r.ok && r.thumbnailUrl ? r.thumbnailUrl : null);
          }
        );
      } catch {
        resolve(null);
      }
    });
  }

  async function decompressFromBase64Url(b64url) {
    let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const out = await new Response(stream).arrayBuffer();
    const text = new TextDecoder().decode(out);
    return JSON.parse(text);
  }

  function showToast(msg) {
    if (!root) return;
    const t = root.querySelector(".mf-toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("mf-show");
    clearTimeout(showToast._tid);
    showToast._tid = setTimeout(() => t.classList.remove("mf-show"), 2600);
  }

  function hideReactionRosterTooltip() {
    clearTimeout(reactionRosterTooltipShowTid);
    reactionRosterTooltipShowTid = null;
    const tip = reactionRosterTooltipEl;
    if (tip) {
      tip.classList.remove("mf-show");
      tip.hidden = true;
      tip.textContent = "";
      tip.style.left = "";
      tip.style.top = "";
      tip.style.visibility = "";
    }
  }

  function ensureReactionRosterTooltipEl() {
    if (!root) return null;
    if (reactionRosterTooltipEl && reactionRosterTooltipEl.isConnected) return reactionRosterTooltipEl;
    const el = document.createElement("div");
    el.className = "mf-reaction-roster-tooltip";
    el.setAttribute("role", "tooltip");
    el.hidden = true;
    root.appendChild(el);
    reactionRosterTooltipEl = el;
    return el;
  }

  function positionReactionRosterTooltip(anchor) {
    const tip = reactionRosterTooltipEl;
    if (!tip || !root || !anchor.isConnected) return;
    tip.classList.add("mf-show");
    tip.hidden = false;
    tip.style.visibility = "hidden";
    tip.style.left = "0";
    tip.style.top = "0";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const ar = anchor.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    let left = ar.left - rr.left + ar.width / 2 - tw / 2;
    let top = ar.top - rr.top - th - 6;
    if (top < 4) top = ar.bottom - rr.top + 6;
    left = Math.max(4, Math.min(left, rr.width - tw - 4));
    top = Math.max(4, Math.min(top, rr.height - th - 4));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "";
  }

  function bindReactionRosterTooltip(pill, rosterText) {
    if (!rosterText) return;
    pill.removeAttribute("title");
    const scheduleShow = () => {
      clearTimeout(reactionRosterTooltipShowTid);
      reactionRosterTooltipShowTid = setTimeout(() => {
        reactionRosterTooltipShowTid = null;
        const tip = ensureReactionRosterTooltipEl();
        if (!tip || !pill.isConnected) return;
        tip.textContent = rosterText;
        positionReactionRosterTooltip(pill);
      }, REACTION_ROSTER_TIP_DELAY_MS);
    };
    const scheduleHide = () => {
      hideReactionRosterTooltip();
    };
    pill.addEventListener("mouseenter", scheduleShow);
    pill.addEventListener("mouseleave", scheduleHide);
    pill.addEventListener("focusin", scheduleShow);
    pill.addEventListener("focusout", scheduleHide);
  }

  function getActiveVideoEl() {
    const c = resolveClipContext();
    return c ? c.getVideoElement() : null;
  }

  function ensureCanvasOverlay(clip) {
    if (!FEATURE_DRAWING) {
      teardownCanvas();
      return;
    }
    const parent = clip.getOverlayParent();
    if (!parent) return;

    const cs = getComputedStyle(parent);
    if (cs.position === "static") {
      parent.style.position = "relative";
    }

    canvasMountParent = parent;

    if (canvasHost && canvasHost.parentNode === parent) {
      syncCanvasSize();
      return;
    }

    teardownCanvas();

    canvasHost = document.createElement("div");
    canvasHost.id = "markframe-canvas-host";
    canvas = document.createElement("canvas");
    canvasHost.appendChild(canvas);
    parent.appendChild(canvasHost);
    ctx = canvas.getContext("2d");

    canvasHost.addEventListener("pointerdown", onPointerDown, true);
    canvasHost.addEventListener("pointermove", onPointerMove, true);
    canvasHost.addEventListener("pointerup", onPointerUp, true);
    canvasHost.addEventListener("pointerleave", onPointerUp, true);

    resizeObs = new ResizeObserver(() => syncCanvasSize());
    resizeObs.observe(parent);
    syncCanvasSize();
    setDrawModeUi(state.drawMode);
  }

  function teardownCanvas() {
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (canvasHost) {
      canvasHost.removeEventListener("pointerdown", onPointerDown, true);
      canvasHost.removeEventListener("pointermove", onPointerMove, true);
      canvasHost.removeEventListener("pointerup", onPointerUp, true);
      canvasHost.removeEventListener("pointerleave", onPointerUp, true);
      canvasHost.remove();
    }
    canvasHost = null;
    canvas = null;
    ctx = null;
    canvasMountParent = null;
  }

  function syncCanvasSize() {
    if (!canvas || !canvasMountParent) return;
    const rect = canvasMountParent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      const hadInk = state.hasInk;
      const prev = ctx ? canvas.toDataURL("image/png") : null;
      canvas.width = w;
      canvas.height = h;
      if (prev && ctx) {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          state.hasInk = hadInk;
        };
        img.src = prev;
      } else {
        state.hasInk = false;
      }
    }
  }

  function clearCanvasVisuals() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    state.hasInk = false;
  }

  function canvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  }

  function onPointerDown(e) {
    if (!state.drawMode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    canvasHost.setPointerCapture(e.pointerId);
    state.drawing = true;
    const p = canvasCoords(e);
    state.lastX = p.x;
    state.lastY = p.y;
    ctx.strokeStyle = state.drawColor;
    ctx.lineWidth = Math.max(2, canvas.width / 200);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function onPointerMove(e) {
    if (!state.drawMode || !state.drawing) return;
    e.preventDefault();
    e.stopPropagation();
    const p = canvasCoords(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    state.hasInk = true;
    state.lastX = p.x;
    state.lastY = p.y;
  }

  function onPointerUp(e) {
    if (!state.drawing) return;
    state.drawing = false;
    try {
      canvasHost.releasePointerCapture(e.pointerId);
    } catch (_) {}
  }

  function setDrawModeUi(on) {
    if (on && !FEATURE_DRAWING) return;
    state.drawMode = on;
    if (!canvasHost) return;
    canvasHost.classList.toggle("mf-draw-on", on);
    canvasHost.style.pointerEvents = on ? "auto" : "none";
    const drawBtn = root && root.querySelector('[data-action="toggle-draw"]');
    if (drawBtn) drawBtn.classList.toggle("mf-active", on);
    if (!on) state.drawing = false;
  }

  function nearestCommentId(currentSec) {
    if (!state.comments.length) return null;
    const roots = state.comments.filter((c) => !c.parentId);
    if (!roots.length) return null;
    let best = roots[0].id;
    let bestDiff = Infinity;
    for (const c of roots) {
      const d = Math.abs((c.ts || 0) - currentSec);
      if (d < bestDiff) {
        bestDiff = d;
        best = c.id;
      }
    }
    return bestDiff <= 5 ? best : null;
  }

  async function saveDrawingToComment() {
    if (!FEATURE_DRAWING) return;
    const clip = resolveClipContext();
    if (!clip || !canvas || !ctx) return;
    if (!state.hasInk) {
      showToast("Nothing drawn yet.");
      return;
    }

    videoEl = clip.getVideoElement();
    const t = videoEl && Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
    const cid = nearestCommentId(t);
    if (!cid) {
      showToast("Add a comment near this time first (within 5s).");
      return;
    }

    const png = canvas.toDataURL("image/png");
    const c = state.comments.find((x) => x.id === cid);
    if (c) {
      const prevDrawing = c.drawing;
      c.drawing = png;
      const ok = await saveClipData(clip);
      if (!ok) {
        if (prevDrawing !== undefined) c.drawing = prevDrawing;
        else delete c.drawing;
        renderThread();
        return;
      }
      renderThread();
      clearCanvasVisuals();
      showToast("Drawing saved to nearest comment.");
    }
  }

  function seekTo(sec, playAfter = true) {
    videoEl = getActiveVideoEl();
    if (videoEl && Number.isFinite(sec)) {
      videoEl.currentTime = sec;
      try {
        if (playAfter) videoEl.play();
        else videoEl.pause();
      } catch (_) {}
    }
  }

  /** Lucide `circle-check` (ISC license) — inlined for content script. */
  function createLucideCircleCheckIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "mf-lucide mf-lucide-circle-check");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "10");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "m9 12 2 2 4-4");
    svg.appendChild(circle);
    svg.appendChild(path);
    return svg;
  }

  /** Lucide `smile-plus` (ISC license) — inlined for content script. */
  function createLucideSmilePlusIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "mf-lucide mf-lucide-smile-plus");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const p1 = document.createElementNS(NS, "path");
    p1.setAttribute("d", "M22 11v1a10 10 0 1 1-9-10");
    const p2 = document.createElementNS(NS, "path");
    p2.setAttribute("d", "M8 14s1.5 2 4 2 4-2 4-2");
    const eyeL = document.createElementNS(NS, "line");
    eyeL.setAttribute("x1", "9");
    eyeL.setAttribute("x2", "9.01");
    eyeL.setAttribute("y1", "9");
    eyeL.setAttribute("y2", "9");
    const eyeR = document.createElementNS(NS, "line");
    eyeR.setAttribute("x1", "15");
    eyeR.setAttribute("x2", "15.01");
    eyeR.setAttribute("y1", "9");
    eyeR.setAttribute("y2", "9");
    const p3 = document.createElementNS(NS, "path");
    p3.setAttribute("d", "M16 5h6");
    const p4 = document.createElementNS(NS, "path");
    p4.setAttribute("d", "M19 2v6");
    svg.appendChild(p1);
    svg.appendChild(p2);
    svg.appendChild(eyeL);
    svg.appendChild(eyeR);
    svg.appendChild(p3);
    svg.appendChild(p4);
    return svg;
  }

  /** Lucide `trash-2` (ISC license) — inlined for content script. */
  function createLucideTrashIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "mf-lucide mf-lucide-trash-2");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const p1 = document.createElementNS(NS, "path");
    p1.setAttribute("d", "M3 6h18");
    const p2 = document.createElementNS(NS, "path");
    p2.setAttribute("d", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6");
    const p3 = document.createElementNS(NS, "path");
    p3.setAttribute("d", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2");
    const l1 = document.createElementNS(NS, "line");
    l1.setAttribute("x1", "10");
    l1.setAttribute("x2", "10");
    l1.setAttribute("y1", "11");
    l1.setAttribute("y2", "17");
    const l2 = document.createElementNS(NS, "line");
    l2.setAttribute("x1", "14");
    l2.setAttribute("x2", "14");
    l2.setAttribute("y1", "11");
    l2.setAttribute("y2", "17");
    svg.appendChild(p1);
    svg.appendChild(p2);
    svg.appendChild(p3);
    svg.appendChild(l1);
    svg.appendChild(l2);
    return svg;
  }

  function uid() {
    return "mf_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function createCommentAvatarEl(comment) {
    const holder = document.createElement("div");
    holder.className = "mf-comment-avatar";
    const label = displayNameForComment(comment);
    const commentAvatar = normalizeCommentAvatarUrl(comment?.avatarUrl);
    const ownAvatar = cachedAuthorAvatarUrl && isOwnComment(comment) ? cachedAuthorAvatarUrl : "";
    const avatarToShow = commentAvatar || ownAvatar;
    const showImg = !!avatarToShow;
    if (showImg) {
      const img = document.createElement("img");
      img.className = "mf-comment-avatar-img";
      img.src = avatarToShow;
      img.alt = "";
      img.width = 22;
      img.height = 22;
      img.loading = "lazy";
      img.decoding = "async";
      const letter = avatarFallbackLetter(label);
      img.addEventListener("error", () => {
        img.remove();
        const fb = document.createElement("span");
        fb.className = "mf-comment-avatar-fallback";
        fb.textContent = letter;
        holder.appendChild(fb);
      });
      holder.appendChild(img);
    } else {
      const fb = document.createElement("span");
      fb.className = "mf-comment-avatar-fallback";
      fb.textContent = avatarFallbackLetter(label);
      holder.appendChild(fb);
    }
    return holder;
  }

  async function addComment(text, replyToId) {
    const clip = resolveClipContext();
    if (!clip) return;
    videoEl = clip.getVideoElement();
    const author = await effectiveDisplayName();
    const trimmed = String(text).trim();
    if (!trimmed) return;

    let ts = videoEl && Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
    let threadParentId = null;
    if (replyToId) {
      const parent = state.comments.find((x) => x.id === replyToId);
      if (parent) {
        ts = parent.ts;
        threadParentId = parent.parentId || parent.id;
      }
    }

    const c = {
      id: uid(),
      ts,
      text: trimmed,
      author,
      avatarUrl: normalizeCommentAvatarUrl(cachedAuthorAvatarUrl),
      createdAt: Date.now(),
      reactions: {},
    };
    if (isGuestSharedReviewActive()) {
      c.isGuest = true;
    } else {
      c.authorId = currentCloudUserId() || "";
    }
    if (threadParentId) {
      c.parentId = threadParentId;
    } else {
      c.complete = false;
      try {
        let frameDataUrl = null;
        if (clip.platform === "googledrive") {
          frameDataUrl = await Promise.race([
            captureGoogleDriveFrameViaVisibleTab({ quiet: true }),
            new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
        } else {
          frameDataUrl = await Promise.race([
            captureVideoFrameWithCrossOriginFallback(videoEl),
            new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
          ]);
        }
        if (frameDataUrl) c.frameCapture = frameDataUrl;
      } catch (_) {
        // frame capture is non-critical, continue without it
      }
    }

    const nextComments = state.comments.concat([c]);
    normalizeCommentListShape(nextComments);
    const ok = await saveClipData(clip, { comments: nextComments });
    if (!ok) return;
    state.comments = nextComments;
    state.replyTargetId = null;
    renderThread();
  }

  function setCommentComplete(id, complete) {
    const c = state.comments.find((x) => x.id === id);
    if (!c || c.parentId) return;
    const clip = resolveClipContext();
    if (!clip) return;
    const prevComplete = c.complete;
    c.complete = !!complete;
    delete c.reaction;
    void (async () => {
      const ok = await saveClipData(clip);
      if (!ok) {
        c.complete = prevComplete;
      }
      renderThread();
    })();
  }

  function repliesSortedForRoot(rootId) {
    return state.comments
      .filter((x) => x.parentId === rootId)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function buildReplyComposerEl(rootCommentId) {
    const wrap = document.createElement("div");
    wrap.className = "mf-reply-composer";
    const row = document.createElement("div");
    row.className = "mf-reply-composer-row";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "mf-reply-input";
    inp.placeholder = "Reply…";
    inp.maxLength = 2000;
    inp.addEventListener("focus", () => {
      if (!autoPauseWhenTypingComments) return;
      const v = getVideoElementForCommentPause();
      if (v && !v.paused) v.pause();
    });
    const post = document.createElement("button");
    post.type = "button";
    post.className = "mf-btn mf-btn-primary mf-reply-post";
    post.textContent = "Post";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mf-btn mf-reply-cancel";
    cancel.textContent = "Cancel";
    function closeComposer() {
      state.replyTargetId = null;
      renderThread();
    }
    cancel.addEventListener("click", (e) => {
      e.preventDefault();
      closeComposer();
    });
    async function submit() {
      const v = inp.value;
      if (!v.trim()) return;
      inp.value = "";
      await addComment(v, rootCommentId);
    }
    post.addEventListener("click", (e) => {
      e.preventDefault();
      void submit();
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeComposer();
      }
    });
    row.appendChild(inp);
    row.appendChild(post);
    row.appendChild(cancel);
    wrap.appendChild(row);
    requestAnimationFrame(() => {
      try {
        inp.focus();
      } catch (_) {}
    });
    return wrap;
  }

  function updateCommentReactionsInState(commentId, updater) {
    if (!commentId || typeof updater !== "function") return false;
    const idx = state.comments.findIndex((x) => x && x.id === commentId);
    if (idx === -1) return false;
    const original = state.comments[idx];
    const next = updater(original);
    if (!next || next === original) return false;
    state.comments[idx] = next;
    return true;
  }

  function toggleCommentReaction(commentId, emoji) {
    if (!COMMENT_REACTION_EMOJIS.includes(emoji)) return;
    const clip = resolveClipContext();
    if (!clip) return;
    const uid = normalizeAuthorId(currentCloudUserId());
    const guestRid = isGuestSharedReviewActive() ? ensureGuestReactorId() : "";
    const actorId = uid || guestRid;
    if (!actorId) {
      showToast("Sign in to react.");
      return;
    }
    const before = state.comments.find((x) => x && x.id === commentId);
    if (!before) return;
    const prevReactions = normalizeCommentReactions(before.reactions);
    const prevEmojiUsers = Array.isArray(prevReactions[emoji]) ? prevReactions[emoji] : [];
    const hasReacted = prevEmojiUsers.includes(actorId);
    const nextEmojiUsers = hasReacted
      ? prevEmojiUsers.filter((id) => id !== actorId)
      : prevEmojiUsers.concat(actorId);
    const nextReactions = { ...prevReactions };
    if (nextEmojiUsers.length) nextReactions[emoji] = nextEmojiUsers;
    else delete nextReactions[emoji];
    const changed = updateCommentReactionsInState(commentId, (comment) => ({
      ...comment,
      reactions: nextReactions,
    }));
    if (!changed) return;
    renderThread();
    pendingReactionSaves += 1;
    void (async () => {
      const ok = await saveClipData(clip);
      if (ok) {
        queueNotifyReactionAfterSave(clip, before, emoji, !hasReacted);
        return;
      }
      updateCommentReactionsInState(commentId, (comment) => ({
        ...comment,
        reactions: prevReactions,
      }));
      renderThread();
    })().finally(() => {
      pendingReactionSaves = Math.max(0, pendingReactionSaves - 1);
    });
  }

  function buildReactionBarEl(comment, opts) {
    const inlineActions = opts?.inlineActions === true;
    const bar = document.createElement("div");
    bar.className = "mf-reaction-bar" + (inlineActions ? " mf-reaction-bar--in-actions" : "");
    const ownForReact =
      normalizeAuthorId(currentCloudUserId()) || (isGuestSharedReviewActive() ? ensureGuestReactorId() : "");
    const canReact = !!ownForReact;
    const reactionPicker = document.createElement("details");
    reactionPicker.className = "mf-reaction-picker";
    const summary = document.createElement("summary");
    summary.className = "mf-reaction-add-btn";
    summary.title = canReact ? "Add reaction" : "Sign in to react";
    summary.appendChild(createLucideSmilePlusIcon());
    reactionPicker.appendChild(summary);
    const menu = document.createElement("div");
    menu.className = "mf-reaction-menu";
    const ownUserId = ownForReact;
    const reactions = ensureCommentReactions(comment);
    for (const emoji of COMMENT_REACTION_EMOJIS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mf-reaction-emoji-btn";
      btn.textContent = emoji;
      const users = reactions[emoji] || [];
      if (ownUserId && users.includes(ownUserId)) btn.classList.add("mf-on");
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        reactionPicker.open = false;
        if (!canReact) {
          showToast("Sign in to react.");
          return;
        }
        toggleCommentReaction(comment.id, emoji);
      });
      menu.appendChild(btn);
    }
    reactionPicker.appendChild(menu);
    const rows = document.createElement("div");
    rows.className = "mf-reaction-list";
    for (const emoji of COMMENT_REACTION_EMOJIS) {
      const users = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
      if (!users.length) continue;
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "mf-reaction-pill";
      if (ownUserId && users.includes(ownUserId)) pill.classList.add("mf-on");
      const pillEmoji = document.createElement("span");
      pillEmoji.className = "mf-reaction-pill-emoji";
      pillEmoji.textContent = emoji;
      const pillCount = document.createElement("span");
      pillCount.className = "mf-reaction-pill-count";
      pillCount.textContent = String(users.length);
      pill.appendChild(pillEmoji);
      pill.appendChild(pillCount);
      const roster = formatReactionHoverTitle(users);
      if (roster) {
        pill.setAttribute("aria-label", roster);
        bindReactionRosterTooltip(pill, roster);
      } else {
        pill.title = canReact ? "Toggle reaction" : "Sign in to react";
      }
      pill.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideReactionRosterTooltip();
        if (!canReact) {
          showToast("Sign in to react.");
          return;
        }
        toggleCommentReaction(comment.id, emoji);
      });
      rows.appendChild(pill);
    }
    function appendDeleteSlot(parent) {
      const del = opts?.deleteControl;
      if (!del) return;
      const slot = document.createElement("span");
      slot.className = "mf-reaction-bar-delete-slot";
      slot.appendChild(del);
      parent.appendChild(slot);
    }

    bar.appendChild(rows);
    const trailing = document.createElement("div");
    trailing.className = "mf-reaction-bar-trailing";
    trailing.appendChild(reactionPicker);
    appendDeleteSlot(trailing);
    bar.appendChild(trailing);
    return bar;
  }

  function goToCommentInVideo(c, isReply) {
    state.selectedId = c.id;
    seekTo(c.ts, false);
    if (FEATURE_DRAWING) {
      let url = null;
      if (isReply) {
        const root = state.comments.find((x) => x.id === c.parentId);
        if (root && root.drawing) url = root.drawing;
      } else if (c.drawing) {
        url = c.drawing;
      }
      if (url) overlayDrawingPreview(url);
      else clearCanvasVisuals();
    }
    renderThread();
  }

  function isReviewRowOwner() {
    const uid = currentCloudUserId();
    const oid = String(state.reviewOwnerUserId || "").trim();
    if (!uid || !oid) return false;
    return normalizeUuidForCompare(uid) === normalizeUuidForCompare(oid);
  }

  function isCommentAuthorForDelete(comment) {
    if (!currentCloudUserId()) return false;
    if (comment?.isGuest === true) return false;
    const uid = currentCloudUserId();
    const aid = normalizeAuthorId(comment?.authorId);
    if (uid && aid && normalizeUuidForCompare(uid) === normalizeUuidForCompare(aid)) return true;
    const author = String(comment?.author || "").trim();
    return !!author && author === cachedEffectiveDisplayName;
  }

  function canDeleteComment(comment) {
    if (isGuestSharedReviewActive()) return false;
    if (!currentCloudUserId()) return false;
    if (isReviewRowOwner()) return true;
    return isCommentAuthorForDelete(comment);
  }

  async function deleteCommentChain(comment) {
    const clip = resolveClipContext();
    if (!clip || !comment || !canDeleteComment(comment)) return;
    const id = comment.id;
    const isReply = !!comment.parentId;
    const toRemove = new Set([id]);
    if (!isReply) {
      for (const c of state.comments) {
        if (c && c.parentId === id) toRemove.add(c.id);
      }
    }
    const next = state.comments.filter((c) => c && !toRemove.has(c.id));
    normalizeCommentListShape(next);
    const ok = await saveClipData(clip, { comments: next });
    if (!ok) return;
    state.comments = next;
    normalizeCommentsShape();
    if (state.replyTargetId && toRemove.has(state.replyTargetId)) state.replyTargetId = null;
    if (!isReply) state.collapsedReplyRoots.delete(id);
    const sel = state.selectedId;
    if (sel && toRemove.has(sel)) state.selectedId = null;
    hideReactionRosterTooltip();
    invalidateReactionPublicNamesCache();
    scheduleReactionPublicNamesRefresh();
    renderThread();
  }

  function mountCommentDeleteTrashUi(wrap, comment) {
    wrap.classList.remove("mf-comment-delete-confirming");
    wrap.replaceChildren();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mf-comment-delete-btn";
    btn.title = "Delete comment";
    btn.setAttribute("aria-label", "Delete comment");
    btn.appendChild(createLucideTrashIcon());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.add("mf-comment-delete-confirming");
      wrap.replaceChildren();
      const prompt = document.createElement("span");
      prompt.className = "mf-comment-delete-prompt";
      prompt.textContent = "Delete?";
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "mf-comment-delete-yes";
      yes.textContent = "Yes";
      const no = document.createElement("button");
      no.type = "button";
      no.className = "mf-comment-delete-no";
      no.textContent = "No";
      no.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        mountCommentDeleteTrashUi(wrap, comment);
      });
      yes.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void deleteCommentChain(comment);
      });
      wrap.appendChild(prompt);
      wrap.appendChild(yes);
      wrap.appendChild(no);
    });
    wrap.appendChild(btn);
  }

  function buildCommentDeleteControl(comment) {
    if (!canDeleteComment(comment)) return null;
    const wrap = document.createElement("span");
    wrap.className = "mf-comment-delete-wrap";
    mountCommentDeleteTrashUi(wrap, comment);
    return wrap;
  }

  function createCommentElement(c, isReply) {
    const el = document.createElement("div");
    el.className = "mf-comment" + (isReply ? " mf-reply" : "");
    if (state.selectedId === c.id) el.classList.add("mf-selected");
    if (!isReply && !c.complete) el.classList.add("mf-incomplete");
    el.addEventListener("click", (e) => {
      if (e.target.closest("button.mf-status-btn")) return;
      if (e.target.closest(".mf-comment-actions")) return;
      if (e.target.closest(".mf-comment-delete-wrap")) return;
      if (e.target.closest(".mf-reaction-bar")) return;
      goToCommentInVideo(c, isReply);
    });

    const top = document.createElement("div");
    top.className = "mf-comment-top";

    const head = document.createElement("div");
    head.className = "mf-comment-head";
    head.appendChild(createCommentAvatarEl(c));

    const bodyCol = document.createElement("div");
    bodyCol.className = "mf-comment-body-col";

    const nameRow = document.createElement("div");
    nameRow.className = "mf-comment-name-row";
    const auth = document.createElement("span");
    auth.className = "mf-author";
    auth.textContent = displayNameForComment(c);
    nameRow.appendChild(auth);
    const createdAt =
      typeof c.createdAt === "number" && Number.isFinite(c.createdAt) ? c.createdAt : null;
    if (createdAt != null) {
      const agoEl = document.createElement("span");
      agoEl.className = "mf-comment-ago";
      agoEl.textContent = formatRelativeAgo(createdAt);
      nameRow.appendChild(agoEl);
    }

    const tsRow = document.createElement("div");
    tsRow.className = "mf-comment-ts-row";
    if (!isReply) {
      const tsBtn = document.createElement("button");
      tsBtn.type = "button";
      tsBtn.className = "mf-ts";
      tsBtn.textContent = formatTime(c.ts);
      tsRow.appendChild(tsBtn);
    }

    const text = document.createElement("span");
    text.className = "mf-comment-text";
    text.textContent = c.text;
    tsRow.appendChild(text);

    bodyCol.appendChild(nameRow);
    bodyCol.appendChild(tsRow);
    head.appendChild(bodyCol);

    top.appendChild(head);

    if (!isReply) {
      const doneWrap = document.createElement("div");
      doneWrap.className = "mf-complete-wrap";
      const statusBtn = document.createElement("button");
      statusBtn.type = "button";
      statusBtn.className = "mf-status-btn" + (c.complete ? " mf-on" : "");
      statusBtn.setAttribute("aria-pressed", c.complete ? "true" : "false");
      statusBtn.title = c.complete ? "Mark incomplete" : "Mark complete";
      statusBtn.appendChild(createLucideCircleCheckIcon());
      statusBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setCommentComplete(c.id, !c.complete);
      });
      doneWrap.appendChild(statusBtn);
      top.appendChild(doneWrap);
    }

    el.appendChild(top);

    if (!isReply && FEATURE_DRAWING && c.drawing) {
      const row = document.createElement("div");
      row.className = "mf-drawing-row";
      const img = document.createElement("img");
      img.className = "mf-drawing-thumb";
      img.src = c.drawing;
      img.alt = "Annotation";
      row.appendChild(img);
      el.appendChild(row);
    }

    if (!isReply) {
      const actions = document.createElement("div");
      actions.className = "mf-comment-actions";
      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      replyBtn.className = "mf-comment-reply-btn";
      replyBtn.textContent = "Reply";
      replyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.replyTargetId = state.replyTargetId === c.id ? null : c.id;
        if (state.replyTargetId === c.id) state.collapsedReplyRoots.delete(c.id);
        renderThread();
      });
      actions.appendChild(replyBtn);
      const delRoot = buildCommentDeleteControl(c);
      actions.appendChild(
        buildReactionBarEl(c, {
          inlineActions: true,
          ...(delRoot ? { deleteControl: delRoot } : {}),
        }),
      );
      el.appendChild(actions);
    } else {
      const delReply = buildCommentDeleteControl(c);
      el.appendChild(
        buildReactionBarEl(c, delReply ? { deleteControl: delReply } : {}),
      );
    }

    return el;
  }

  function updateCopyReviewLinkButtonState() {
    if (!root) return;
    const copyBtn = root.querySelector('[data-action="copy-link"]');
    if (!copyBtn) return;
    const hasComments = Array.isArray(state.comments) && state.comments.length > 0;
    const pro = isProUser();
    if (pro) {
      copyBtn.disabled = !hasComments;
      copyBtn.title = hasComments ? "Copy review link" : "Needs at least 1 comment first";
    } else {
      copyBtn.disabled = false;
      copyBtn.title =
        "Pro — Copy a shareable link to this review on notch.video. Upgrade to unlock.";
    }
  }

  function updateExportPdfButtonState() {
    if (!root) return;
    const btn = root.querySelector('[data-action="export-pdf"]');
    if (!btn) return;
    const hasComments = Array.isArray(state.comments) && state.comments.length > 0;
    const pro = isProUser();
    const baseLabel = "Export PDF";
    if (pro) {
      btn.disabled = !hasComments;
      btn.title = hasComments ? baseLabel : "Needs at least 1 comment first";
      btn.setAttribute("aria-label", hasComments ? baseLabel : "Export PDF — needs at least 1 comment first");
    } else {
      btn.disabled = false;
      btn.title =
        "Pro — Download a PDF report with comments and video frames. Upgrade to unlock.";
      btn.setAttribute("aria-label", "Export PDF (Pro only — upgrade to unlock)");
    }
  }

  function renderThread() {
    if (!root) return;
    hideReactionRosterTooltip();
    refreshProGatedToolbar();
    const thread = root.querySelector(".mf-thread");
    if (!thread) return;
    thread.innerHTML = "";
    const allRoots = state.comments
      .filter((c) => !c.parentId)
      .sort((a, b) => a.ts - b.ts);
    const f = state.commentCompleteFilter;
    const roots =
      f === "complete"
        ? allRoots.filter((c) => c.complete)
        : f === "incomplete"
          ? allRoots.filter((c) => !c.complete)
          : allRoots;
    if (!roots.length) {
      const empty = document.createElement("div");
      empty.className = "mf-empty";
      empty.textContent = allRoots.length
        ? "No comments match this filter."
        : "No comments yet.";
      thread.appendChild(empty);
      scheduleReactionPublicNamesRefresh();
      return;
    }

    for (const rootComment of roots) {
      const block = document.createElement("div");
      block.className = "mf-comment-block";
      const rootEl = createCommentElement(rootComment, false);
      const reps = repliesSortedForRoot(rootComment.id);
      const replyCount = reps.length;
      block.appendChild(rootEl);
      if (replyCount) {
        const repliesEl = document.createElement("div");
        repliesEl.className = "mf-replies";
        for (const r of reps) repliesEl.appendChild(createCommentElement(r, true));
        block.appendChild(repliesEl);
      }
      if (state.replyTargetId === rootComment.id) {
        block.appendChild(buildReplyComposerEl(rootComment.id));
      }
      thread.appendChild(block);
    }
    scheduleReactionPublicNamesRefresh();
  }

  let previewTimer = null;
  function overlayDrawingPreview(dataUrl) {
    if (!ctx || !canvas) return;
    clearCanvasVisuals();
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        if (!state.drawMode) clearCanvasVisuals();
      }, 2200);
    };
    img.src = dataUrl;
  }

  function buildSidebarHtml() {
    const wrap = document.createElement("div");
    wrap.id = "markframe-root";
    wrap.dataset.mfView = "watch";
    wrap.dataset.mfReviewUi = "loading";
    wrap.innerHTML = `
      <div class="mf-gate-pane">
        <p class="mf-gate-title"></p>
        <p class="mf-gate-msg"></p>
        <div class="mf-gate-form mf-hidden">
          <div class="mf-gate-actions">
            <button type="button" class="mf-btn mf-btn-primary mf-gate-btn-google" data-action="gate-google-auth">
              Continue with Google
            </button>
          </div>
          <div class="mf-gate-or-wrap" aria-hidden="true">
            <span class="mf-gate-or-line"></span>
            <span class="mf-gate-or-label">or</span>
            <span class="mf-gate-or-line"></span>
          </div>
          <div id="mf-gate-fields" class="mf-gate-fields">
            <label class="mf-gate-label"
              >Email
              <input
                type="email"
                class="mf-gate-input mf-gate-email"
                autocomplete="username"
                maxlength="320"
              />
            </label>
          </div>
          <p class="mf-gate-status" aria-live="polite"></p>
          <div class="mf-gate-actions">
            <button type="button" class="mf-btn mf-gate-btn-magic-link" data-action="gate-magic-link">
              Send magic link
            </button>
          </div>
        </div>
      </div>
      <div class="mf-guest-invite-overlay mf-hidden" aria-hidden="true">
        <div
          class="mf-guest-invite-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mf-guest-invite-title"
          tabindex="-1"
        >
          <h2 id="mf-guest-invite-title" class="mf-guest-invite-title">You've been invited to review a video</h2>
          <p class="mf-guest-invite-subtitle" aria-live="polite"></p>
          <div class="mf-guest-invite-choice">
            <button type="button" class="mf-guest-invite-primary" data-action="guest-continue">
              Continue as guest
            </button>
            <button type="button" class="mf-guest-invite-link" data-action="guest-sign-up">
              Sign up free
            </button>
          </div>
          <div class="mf-guest-invite-name-panel mf-hidden">
            <input
              type="text"
              class="mf-guest-invite-name-input"
              maxlength="80"
              autocomplete="nickname"
              spellcheck="false"
              placeholder="Your name"
              aria-label="Your name"
            />
            <p class="mf-guest-invite-error mf-hidden" aria-live="polite">Enter your name to continue.</p>
            <button type="button" class="mf-guest-invite-join" data-action="guest-join-review">Join review</button>
            <button type="button" class="mf-guest-invite-link mf-guest-invite-link-below" data-action="guest-sign-up-from-name">
              Sign up free
            </button>
          </div>
        </div>
      </div>
      <div class="mf-app-shell mf-hidden">
        <div class="mf-header">
          <div class="mf-header-text mf-header-text--loading">
            <div class="mf-brand">Notch<span class="mf-dot">.</span></div>
            <p class="mf-header-loading-msg" aria-live="polite">Loading review…</p>
            <p class="mf-header-sync-msg" aria-live="polite"></p>
          </div>
          <div class="mf-header-text mf-header-text--start mf-hidden">
            <div class="mf-brand">Notch<span class="mf-dot">.</span></div>
            <p class="mf-header-sync-msg" aria-live="polite"></p>
          </div>
          <div class="mf-header-text mf-header-text--active mf-hidden">
            <span class="mf-watch-header-title" role="status" aria-live="polite"></span>
            <span class="mf-watch-review-owner" role="status" aria-live="polite"></span>
            <p class="mf-header-sync-msg" aria-live="polite"></p>
          </div>
          <div class="mf-header-actions">
            <button type="button" class="mf-settings-btn" data-action="open-settings" title="Settings" aria-label="Settings">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button type="button" class="mf-collapse" data-action="collapse" title="Collapse">▾</button>
            <button type="button" class="mf-sidebar-close" data-action="close-sidebar" title="Close" aria-label="Close sidebar">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div class="mf-watch-pane">
          <div class="mf-review-loading-pane" aria-busy="true" aria-label="Loading review">
            <div class="mf-review-loading-body">
              <div class="mf-review-loading-line mf-title-skeleton"></div>
              <div class="mf-review-loading-line mf-review-loading-line--short mf-title-skeleton"></div>
              <div class="mf-review-loading-line mf-review-loading-line--toolbar mf-title-skeleton"></div>
            </div>
          </div>
          <div class="mf-start-review-pane mf-hidden">
            <div class="mf-start-review-body">
              <div class="mf-start-review-title-row">
                <div class="mf-title-skeleton" aria-hidden="true"></div>
                <span class="mf-start-review-title mf-hidden" role="status" aria-live="polite"></span>
              </div>
              <button type="button" class="mf-btn mf-btn-primary mf-start-review-btn" data-action="start-review">Start review</button>
            </div>
          </div>
          <div class="mf-review-active-pane mf-hidden">
          <div class="mf-toolbar">
            <div class="mf-toolbar-draw${FEATURE_DRAWING ? "" : " mf-hidden"}">
              <button type="button" class="mf-btn" data-action="toggle-draw">Draw</button>
              <input type="color" class="mf-color" data-action="color" value="#00E5FF" aria-label="Stroke color" />
              <button type="button" class="mf-btn mf-btn-primary" data-action="save-draw">Save drawing</button>
            </div>
            <button type="button" class="mf-btn mf-toolbar-copy-link-btn mf-settings-pro-disabled mf-pro-gate-toolbar-btn" data-action="copy-link"><span class="mf-toolbar-copy-link-label">Copy review link</span><span class="mf-pro-badge">Pro</span></button>
            <button type="button" class="mf-btn mf-export-pdf-btn mf-settings-pro-disabled mf-pro-gate-toolbar-btn" data-action="export-pdf" title="Export PDF" aria-label="Export PDF">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-file-down" aria-hidden="true">
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                <path d="M12 18v-6" />
                <path d="m9 15 3 3 3-3" />
                <path d="M4 12V4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2" />
              </svg>
              <span class="mf-pro-badge">Pro</span>
            </button>
            <button
              type="button"
              class="mf-btn mf-screengrab-download-btn"
              data-action="screengrab-download"
              title="Download screengrab (PNG)"
              aria-label="Download screengrab"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-image-down" aria-hidden="true">
                <path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21" />
                <path d="m14 19 3 3v-5.5" />
                <path d="m17 22 3-3" />
                <circle cx="9" cy="9" r="2" />
              </svg>
            </button>
            <button
              type="button"
              class="mf-btn mf-screengrab-copy-btn"
              data-action="screengrab-copy"
              title="Copy screengrab to clipboard"
              aria-label="Copy screengrab to clipboard"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-clipboard" aria-hidden="true">
                <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              </svg>
            </button>
            <div class="mf-toolbar-filter-dropdown">
              <button
                type="button"
                class="mf-btn mf-toolbar-filter-btn"
                data-action="toggle-comment-filter"
                title="Filter comments"
                aria-label="Filter comments"
                aria-expanded="false"
                aria-haspopup="true"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-list-filter" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M7 12h10" />
                  <path d="M10 18h4" />
                </svg>
              </button>
              <div class="mf-toolbar-filter-menu" role="menu" aria-label="Comment filters">
                <button type="button" class="mf-toolbar-filter-option" role="menuitemradio" data-value="complete" data-action="set-comment-filter" aria-checked="false">
                  Complete
                </button>
                <button type="button" class="mf-toolbar-filter-option" role="menuitemradio" data-value="incomplete" data-action="set-comment-filter" aria-checked="false">
                  Incomplete
                </button>
                <div class="mf-toolbar-filter-menu-footer">
                  <button type="button" class="mf-toolbar-filter-clear" data-action="clear-comment-filter">
                    Clear filters
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="mf-thread"></div>
          <div class="mf-footer">
            <div class="mf-guest-footer-row mf-hidden" aria-live="polite">
              <span class="mf-guest-footer-line">
                Commenting as <span class="mf-guest-footer-name"></span> ·
                <button type="button" class="mf-guest-footer-not-you">Not you?</button>
              </span>
            </div>
            <div class="mf-input-row">
              <input type="text" class="mf-comment-input" placeholder="Comment at current time…" maxlength="2000" />
            </div>
          </div>
          </div>
        </div>
      </div>
      <div class="mf-settings-overlay mf-hidden" aria-hidden="true">
        <div
          class="mf-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mf-settings-heading"
          tabindex="-1"
        >
          <div class="mf-settings-header">
            <h2 id="mf-settings-heading" class="mf-settings-title">Settings</h2>
            <button type="button" class="mf-settings-close" data-action="close-settings" aria-label="Close settings">
              ×
            </button>
          </div>
          <div class="mf-settings-body">
            <section class="mf-settings-section mf-settings-guest-only mf-hidden" aria-label="Guest identity">
              <div class="mf-settings-guest-identity mf-guest-footer-line">
                Commenting as <span class="mf-settings-guest-name"></span> ·
                <button type="button" class="mf-guest-footer-not-you">Not you?</button>
              </div>
            </section>
            <section class="mf-settings-section">
              <div class="mf-settings-section-heading">Panel</div>
              <div class="mf-settings-row">
                <span>Position</span>
                <div class="mf-settings-dropdown" data-key="panelPosition">
                  <button type="button" class="mf-settings-dropdown-btn"><span class="mf-settings-dropdown-value mf-settings-panel-position-value">Bottom right</span><span class="mf-settings-chevron">▾</span></button>
                  <div class="mf-settings-dropdown-menu">
                    <button type="button" data-value="br">Bottom right</button><button type="button" data-value="bl">Bottom left</button><button type="button" data-value="tr">Top right</button><button type="button" data-value="tl">Top left</button>
                  </div>
                </div>
              </div>
              <label class="mf-settings-row mf-settings-signed-in-only"><span>Auto-pause when typing</span><input type="checkbox" class="mf-settings-auto-pause-comments mf-settings-toggle" /></label>
              <label class="mf-settings-row"><span>Float panel</span><input type="checkbox" class="mf-settings-float-panel mf-settings-toggle" /></label>
            </section>
            <p class="mf-settings-popup-hint mf-settings-signed-in-only">
              Profile, notifications, PDF logo, account, and plan are in the extension toolbar popup (gear on the Notch icon).
            </p>
            <div class="mf-settings-guest-footer mf-settings-guest-only mf-hidden">
              <button type="button" class="mf-settings-cta-btn" data-action="guest-settings-sign-in">Sign in to Notch</button>
            </div>
          </div>
        </div>
      </div>
      <div class="mf-pdf-export-overlay mf-hidden" aria-hidden="true">
        <div
          class="mf-settings-dialog mf-pdf-export-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mf-pdf-export-heading"
          tabindex="-1"
        >
          <div class="mf-settings-header mf-pdf-export-header">
            <h2 id="mf-pdf-export-heading" class="mf-settings-title">Export PDF</h2>
            <button type="button" class="mf-settings-close" data-action="close-pdf-export" aria-label="Close export">
              ×
            </button>
          </div>
          <div class="mf-settings-body mf-pdf-export-body">
            <section class="mf-settings-section mf-pdf-export-fields">
              <label class="mf-pdf-export-field">
                <span class="mf-pdf-export-field-label">Project</span>
                <input
                  type="text"
                  class="mf-settings-display-name mf-pdf-export-project"
                  maxlength="500"
                  required
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
              <label class="mf-pdf-export-field">
                <span class="mf-pdf-export-field-label">Prepared by</span>
                <input
                  type="text"
                  class="mf-settings-display-name mf-pdf-export-prepared-by"
                  maxlength="500"
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
              <label class="mf-pdf-export-field">
                <span class="mf-pdf-export-field-label">Prepared for <span class="mf-pdf-export-optional">(optional)</span></span>
                <input
                  type="text"
                  class="mf-settings-display-name mf-pdf-export-prepared-for"
                  maxlength="500"
                  spellcheck="false"
                  autocomplete="off"
                />
              </label>
            </section>
            <p class="mf-pdf-export-error mf-hidden" role="alert" aria-live="polite"></p>
            <button type="button" class="mf-settings-cta-btn mf-pdf-export-submit">Generate PDF</button>
          </div>
        </div>
      </div>
      <div class="mf-toast" aria-live="polite"></div>
    `;
    return wrap;
  }

  /**
   * Watch body UI phase: `loading` (no start/active yet), `start` (no cloud row), or `active` (has review row).
   * Hides all phase panes/headers then shows only the current phase — avoids toggle() getting out of sync with the DOM.
   */
  function applyWatchReviewUiPhase(phase, _clip) {
    if (!root) return;
    const loading = phase === "loading";
    const start = phase === "start";
    root.dataset.mfReviewUi = loading ? "loading" : start ? "start" : "active";

    const hdrLoad = root.querySelector(".mf-header-text--loading");
    const hdrStart = root.querySelector(".mf-header-text--start");
    const hdrActive = root.querySelector(".mf-header-text--active");
    const paneLoad = root.querySelector(".mf-review-loading-pane");
    const paneStart = root.querySelector(".mf-start-review-pane");
    const paneActive = root.querySelector(".mf-review-active-pane");

    const hideEl = (el) => {
      if (el) el.classList.add("mf-hidden");
    };
    const showEl = (el) => {
      if (el) el.classList.remove("mf-hidden");
    };

    hideEl(hdrLoad);
    hideEl(hdrStart);
    hideEl(hdrActive);
    hideEl(paneLoad);
    hideEl(paneStart);
    hideEl(paneActive);

    if (loading) {
      showEl(hdrLoad);
      showEl(paneLoad);
    } else if (start) {
      showEl(hdrStart);
      showEl(paneStart);
    } else {
      showEl(hdrActive);
      showEl(paneActive);
    }
  }

  function updateWatchChromeForReviewMode(clip) {
    if (!root) return;
    const start =
      !!clip &&
      state.noOwnerReviewRow &&
      isCloudActive() &&
      !isGuestSharedReviewActive();
    applyWatchReviewUiPhase(start ? "start" : "active", clip);
  }

  async function onStartReviewClicked() {
    const clip = resolveClipContext();
    if (!clip || !isCloudActive()) {
      showToast("Sign in to start a review.");
      return;
    }
    const btn = root?.querySelector('[data-action="start-review"]');
    if (btn) btn.disabled = true;
    try {
      await mergeClipMetadata(clip);
      const prevPopupReviews = (await safeStorageLocalGet(POPUP_CACHE_KEY_REVIEWS))[POPUP_CACHE_KEY_REVIEWS];
      const ok = await saveClipData(clip);
      if (!ok) {
        showToast("Could not create review — try again.");
        return;
      }
      await mergeNewReviewIntoPopupReviewsCache(clip, prevPopupReviews);
      state.noOwnerReviewRow = false;
      clearState1TitleRetryPoll();
      applyWatchReviewUiPhase("loading", clip);
      try {
        await loadClipData(clip);
        updateWatchChromeForReviewMode(clip);
        await mergeClipMetadata(clip);
        await refreshWatchVideoTitle(clip);
        await updateWatchHeaderSub(clip);
      } finally {
        if (root && root.dataset.mfReviewUi === "loading") {
          updateWatchChromeForReviewMode(clip);
        }
      }
      renderThread();
      refreshProGatedToolbar();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function hideSidebarForThisTab() {
    try {
      sessionStorage.setItem(SESSION_KEY_SIDEBAR_HIDDEN, "true");
    } catch {
      /* ignore */
    }
    applySidebarDomFromEffective(false);
  }

  function wireSidebar() {
    root.querySelector('[data-action="close-sidebar"]')?.addEventListener("click", () => {
      hideSidebarForThisTab();
    });

    root.querySelector('[data-action="start-review"]')?.addEventListener("click", () => {
      void onStartReviewClicked();
    });

    root.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      root.classList.toggle("mf-collapsed", state.collapsed);
      const btn = root.querySelector('[data-action="collapse"]');
      btn.textContent = state.collapsed ? "▸" : "▾";
      if (!state.collapsed) {
        void refreshWatchClipFromSupabase();
      }
    });
    const bindPanelDragHandle = (handleEl) => {
      if (!handleEl) return;
      handleEl.addEventListener("mousedown", (e) => {
        if (!root || root.dataset.mfFloating !== "1") return;
        const target = e.target instanceof Element ? e.target : null;
        if (target && target.closest("button,input,textarea,select,a")) return;
        const rect = root.getBoundingClientRect();
        panelDragState = {
          pointerX: e.clientX,
          pointerY: e.clientY,
          left: rect.left,
          top: rect.top,
        };
        e.preventDefault();
      });
    };
    bindPanelDragHandle(root.querySelector(".mf-header"));
    bindPanelDragHandle(root.querySelector(".mf-settings-header"));
    if (root) {
      document.addEventListener("mousemove", (e) => {
        if (!root || !panelDragState || root.dataset.mfFloating !== "1") return;
        const dx = e.clientX - panelDragState.pointerX;
        const dy = e.clientY - panelDragState.pointerY;
        root.style.left = Math.max(4, panelDragState.left + dx) + "px";
        root.style.top = Math.max(4, panelDragState.top + dy) + "px";
        root.style.right = "auto";
        root.style.bottom = "auto";
      });
      document.addEventListener("mouseup", () => {
        panelDragState = null;
      });
    }

    root.querySelector('[data-action="open-settings"]').addEventListener("click", () =>
      void openSettingsPanel({ persistGlobal: true })
    );
    root.querySelectorAll('[data-action="close-settings"]').forEach((b) => {
      b.addEventListener("click", () => void closeSettingsPanel({ persistGlobal: true }));
    });
    const settingsOverlay = root.querySelector(".mf-settings-overlay");
    if (settingsOverlay) {
      settingsOverlay.addEventListener("click", (e) => {
        if (e.target === settingsOverlay) void closeSettingsPanel({ persistGlobal: true });
      });
    }
    const pdfExportOverlay = root.querySelector(".mf-pdf-export-overlay");
    if (pdfExportOverlay) {
      pdfExportOverlay.addEventListener("click", (e) => {
        if (e.target === pdfExportOverlay) closePdfExportModal();
      });
    }
    root.querySelectorAll('[data-action="close-pdf-export"]').forEach((b) => {
      b.addEventListener("click", () => closePdfExportModal());
    });
    const pdfSubmit = root.querySelector(".mf-pdf-export-submit");
    if (pdfSubmit) {
      pdfSubmit.addEventListener("click", () => void submitPdfExportModal());
    }
    root.querySelectorAll(".mf-settings-dropdown-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const parent = btn.closest(".mf-settings-dropdown");
        if (!parent) return;
        const opening = !parent.classList.contains("mf-open");
        root.querySelectorAll(".mf-settings-dropdown.mf-open").forEach((el) => {
          if (el !== parent) el.classList.remove("mf-open");
        });
        parent.classList.toggle("mf-open", opening);
      });
    });
    root.querySelectorAll(".mf-settings-dropdown-menu button").forEach((btn) => {
      btn.addEventListener("click", () => {
        void handleSettingsDropdownPick(btn);
      });
    });

    const autoPauseToggle = root.querySelector(".mf-settings-auto-pause-comments");
    if (autoPauseToggle) {
      autoPauseToggle.addEventListener("change", () => {
        void updateCachedPreferences({ autoPause: !!autoPauseToggle.checked }).then((next) =>
          queueSupabasePreferenceSync(next)
        );
        void safeStorageLocalSet({ [STORAGE_KEYS.autoPauseCommentTyping]: !!autoPauseToggle.checked });
        applyAutoPauseCommentTypingPref(autoPauseToggle.checked);
      });
    }
    const floatToggle = root.querySelector(".mf-settings-float-panel");
    if (floatToggle) {
      floatToggle.addEventListener("change", () => {
        void updateCachedPreferences({ floatPanel: !!floatToggle.checked }).then((next) =>
          queueSupabasePreferenceSync(next)
        );
        applyFloatPanelPref(floatToggle.checked);
      });
    }
    const gateGoogle = root.querySelector('[data-action="gate-google-auth"]');
    if (gateGoogle) {
      gateGoogle.addEventListener("click", () => void submitGateGoogleAuth());
    }
    const gateMagicLink = root.querySelector('[data-action="gate-magic-link"]');
    if (gateMagicLink) {
      gateMagicLink.addEventListener("click", () => void submitGateMagicLink());
    }
    const gateEmail = root.querySelector(".mf-gate-email");
    if (gateEmail) {
      gateEmail.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submitGateMagicLink();
        }
      });
    }

    root.querySelector('[data-action="toggle-draw"]').addEventListener("click", () => {
      setDrawModeUi(!state.drawMode);
    });

    root.querySelector('[data-action="color"]').addEventListener("input", (e) => {
      state.drawColor = e.target.value;
    });

    root.querySelector('[data-action="save-draw"]').addEventListener("click", () => {
      saveDrawingToComment();
    });

    const copyLinkBtn = root.querySelector('[data-action="copy-link"]');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener("click", () => {
        if (copyLinkBtn.disabled) return;
        copyReviewLink();
      });
    }
    const exportPdfBtn = root.querySelector('[data-action="export-pdf"]');
    if (exportPdfBtn) {
      exportPdfBtn.addEventListener("click", () => {
        if (exportPdfBtn.disabled) return;
        void openPdfExportModal();
      });
    }

    root.querySelector('[data-action="screengrab-download"]').addEventListener("click", () => {
      void downloadCurrentVideoFrame();
    });
    root.querySelector('[data-action="screengrab-copy"]').addEventListener("click", () => {
      void copyCurrentVideoFrameToClipboard();
    });

    const filterToggle = root.querySelector('[data-action="toggle-comment-filter"]');
    if (filterToggle) {
      filterToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const wrap = root.querySelector(".mf-toolbar-filter-dropdown");
        if (!wrap) return;
        wrap.classList.toggle("mf-open");
        updateCommentFilterToolbarUi();
      });
    }
    root.querySelectorAll('[data-action="set-comment-filter"]').forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const v = el.getAttribute("data-value");
        if (v !== "complete" && v !== "incomplete") return;
        state.commentCompleteFilter = v;
        closeCommentFilterDropdown();
        renderThread();
      });
    });
    const clearFilterBtn = root.querySelector('[data-action="clear-comment-filter"]');
    if (clearFilterBtn) {
      clearFilterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.commentCompleteFilter = null;
        closeCommentFilterDropdown();
        renderThread();
      });
    }
    document.addEventListener(
      "click",
      (e) => {
        if (!root) return;
        const menu =
          e.target instanceof Element ? e.target.closest(".mf-toolbar-filter-dropdown") : null;
        if (!menu) closeCommentFilterDropdown();
      },
      true
    );

    const commentInp = root.querySelector(".mf-comment-input");
    commentInp.addEventListener("focus", () => {
      if (!autoPauseWhenTypingComments) return;
      const v = getVideoElementForCommentPause();
      if (v && !v.paused) v.pause();
    });
    commentInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const v = commentInp.value;
        if (!v.trim()) return;
        commentInp.value = "";
        addComment(v);
      }
    });

    const guestContinue = root.querySelector('[data-action="guest-continue"]');
    if (guestContinue) {
      guestContinue.addEventListener("click", () => {
        const choice = root.querySelector(".mf-guest-invite-choice");
        const namePanel = root.querySelector(".mf-guest-invite-name-panel");
        const nameInp = root.querySelector(".mf-guest-invite-name-input");
        const err = root.querySelector(".mf-guest-invite-error");
        err?.classList.add("mf-hidden");
        choice?.classList.add("mf-hidden");
        namePanel?.classList.remove("mf-hidden");
        if (nameInp) {
          nameInp.value = readNotchGuestNameFromLocalStorage();
          requestAnimationFrame(() => {
            try {
              nameInp.focus();
            } catch (_) {}
          });
        }
      });
    }
    function openAuthGateFromGuestFlow() {
      guestAuthRouteGate = true;
      resetGuestInviteModalUi();
      syncRootChromeVisibility({ guestInvite: false, unlocked: false });
      lastTickSignature = "";
      void tick();
    }
    root.querySelector('[data-action="guest-sign-up"]')?.addEventListener("click", () => {
      openAuthGateFromGuestFlow();
    });
    root.querySelector('[data-action="guest-sign-up-from-name"]')?.addEventListener("click", () => {
      openAuthGateFromGuestFlow();
    });
    root.querySelector('[data-action="guest-settings-sign-in"]')?.addEventListener("click", () => {
      void closeSettingsPanel({ persistGlobal: true });
      openAuthGateFromGuestFlow();
    });
    root.querySelector('[data-action="guest-join-review"]')?.addEventListener("click", () => {
      const nameInp = root.querySelector(".mf-guest-invite-name-input");
      const err = root.querySelector(".mf-guest-invite-error");
      const name = String(nameInp?.value || "").trim();
      if (!name) {
        err?.classList.remove("mf-hidden");
        return;
      }
      err?.classList.add("mf-hidden");
      writeNotchGuestNameToLocalStorage(name);
      ensureGuestReactorId();
      state.guestSession = { isGuest: true, guestName: name };
      guestAuthRouteGate = false;
      resetGuestInviteModalUi();
      lastTickSignature = "";
      void tick();
    });
    root.querySelectorAll(".mf-guest-footer-not-you").forEach((btn) => {
      btn.addEventListener("click", () => {
        void closeSettingsPanel({ persistGlobal: true });
        clearGuestIdentityLocalStorage();
        state.guestSession = null;
        guestAuthRouteGate = false;
        resetGuestInviteModalUi();
        clearGuestSharedPoll();
        lastTickSignature = "";
        void tick();
      });
    });
  }

  function sanitizeFilenamePart(s) {
    return String(s || "video")
      .replace(/[^a-z0-9_-]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 72) || "video";
  }

  function formatTimestampForFilename(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}h${pad(m)}m${pad(r)}s` : `${pad(m)}m${pad(r)}s`;
  }

  function formatExportStampForFilename() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  }

  function clampVideoSeekTime(video, timeSec) {
    let t = Number.isFinite(timeSec) ? timeSec : 0;
    if (t < 0) t = 0;
    const d = video.duration;
    if (Number.isFinite(d) && d > 0) {
      const eps = 0.06;
      t = Math.min(t, Math.max(eps, d - eps));
    }
    return t;
  }

  function seekVideoAwaitSeeked(video, timeSec, timeoutMs) {
    const target = clampVideoSeekTime(video, timeSec);
    return new Promise((resolve, reject) => {
      let done = false;
      let tid = null;
      let poll = null;
      function cleanup() {
        if (tid !== null) {
          clearTimeout(tid);
          tid = null;
        }
        if (poll !== null) {
          clearInterval(poll);
          poll = null;
        }
        video.removeEventListener("seeked", onSeeked);
      }
      function finishOk() {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      }
      function finishErr(e) {
        if (done) return;
        done = true;
        cleanup();
        reject(e);
      }
      /** Keyframe-snapped streams can land a few seconds from `target`; don't reject that as "not done". */
      const nearTarget = () => Math.abs((video.currentTime || 0) - target) <= 4.5;

      function checkSettled() {
        if (done) return;
        if (video.seeking) return;
        if (!nearTarget()) return;
        finishOk();
      }
      const onSeeked = () => finishOk();

      tid = setTimeout(() => finishErr(new Error("seek timeout")), timeoutMs);

      if (Math.abs((video.currentTime || 0) - target) < 0.05 && !video.seeking) {
        finishOk();
        return;
      }

      video.addEventListener("seeked", onSeeked, { once: true });
      poll = setInterval(checkSettled, 90);
      try {
        video.currentTime = target;
      } catch (e) {
        finishErr(e);
        return;
      }
      requestAnimationFrame(checkSettled);
    });
  }

  async function waitVideoHasDrawableFrame(video, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (
        !video.seeking &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 45));
    }
    return false;
  }

  /** Draw current frame to canvas; no toasts. */
  function videoFrameToCaptureCanvas(raw) {
    if (!(raw instanceof HTMLVideoElement) || !raw.isConnected) return null;
    if (raw.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    const vw = raw.videoWidth;
    const vh = raw.videoHeight;
    if (!vw || !vh) return null;
    const c = document.createElement("canvas");
    c.width = vw;
    c.height = vh;
    const g = c.getContext("2d");
    if (!g) return null;
    try {
      g.drawImage(raw, 0, 0, vw, vh);
    } catch (e) {
      return null;
    }
    return { canvas: c, w: vw, h: vh };
  }

  /** PNG data URL from current frame, or null (no user toasts). */
  function videoElementToPngDataUrl(raw) {
    const cap = videoFrameToCaptureCanvas(raw);
    if (!cap) return null;
    try {
      return cap.canvas.toDataURL("image/png");
    } catch (e) {
      return null;
    }
  }

  /** JPEG data URL (640×360) for comment thumbnails; cross-origin fallback for tainted canvases (e.g. Google Drive). */
  async function captureVideoFrameWithCrossOriginFallback(videoEl) {
    if (!videoEl) return null;
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return null;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const scale = Math.min(640 / vw, 360 / vh);
      const w = vw * scale;
      const h = vh * scale;
      ctx.fillStyle = "#0a0e14";
      ctx.fillRect(0, 0, 640, 360);
      ctx.drawImage(videoEl, (640 - w) / 2, (360 - h) / 2, w, h);
      return canvas.toDataURL("image/jpeg", 0.7);
    } catch (e) {
      const srcUrl = videoEl.currentSrc || videoEl.src;
      if (!srcUrl) return null;

      return await new Promise((resolve) => {
        const v = document.createElement("video");
        v.crossOrigin = "anonymous";
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";

        const timeout = setTimeout(() => {
          v.removeAttribute("src");
          v.load();
          resolve(null);
        }, 3000);

        v.onloadeddata = () => {
          try {
            v.currentTime = videoEl.currentTime;
          } catch (_) {}
        };

        v.onseeked = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 360;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              clearTimeout(timeout);
              v.removeAttribute("src");
              v.load();
              resolve(null);
              return;
            }
            const scale = Math.min(640 / v.videoWidth, 360 / v.videoHeight);
            const w = v.videoWidth * scale;
            const h = v.videoHeight * scale;
            ctx.fillStyle = "#0a0e14";
            ctx.fillRect(0, 0, 640, 360);
            ctx.drawImage(v, (640 - w) / 2, (360 - h) / 2, w, h);
            clearTimeout(timeout);
            v.removeAttribute("src");
            v.load();
            resolve(canvas.toDataURL("image/jpeg", 0.7));
          } catch (_) {
            clearTimeout(timeout);
            v.removeAttribute("src");
            v.load();
            resolve(null);
          }
        };

        v.onerror = () => {
          clearTimeout(timeout);
          v.removeAttribute("src");
          v.load();
          resolve(null);
        };

        try {
          v.currentTime = videoEl.currentTime;
        } catch (_) {}
        v.src = srcUrl;
        v.load();
      });
    }
  }

  function getClipVideoDurationSecondsForExport(clip) {
    if (!clip) return null;
    const el = clip.getVideoElement();
    if (!el) return null;
    const d = el.duration;
    if (!Number.isFinite(d) || d <= 0) return null;
    return d;
  }

  function formatVideoDurationForPdfExport(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function buildNestedCommentsForPdfExport() {
    const list = Array.isArray(state.comments) ? state.comments : [];
    const roots = list.filter((c) => c && !c.parentId).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return roots.map((root) => {
      const copy = JSON.parse(JSON.stringify(root));
      const reps = list
        .filter((x) => x && x.parentId === root.id)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map((r) => JSON.parse(JSON.stringify(r)));
      copy.frameCapture = copy.frameCapture || "";
      copy.replies = reps;
      return copy;
    });
  }

  function pdfExportPreparedByLine(prefs, emailFallback) {
    const displayName = String(prefs?.displayName || "").trim() || String(emailFallback || "").trim();
    const companyName = String(prefs?.companyName || "").trim();
    if (companyName) return `${displayName} · ${companyName}`;
    return displayName;
  }

  function closePdfExportModal() {
    if (!root) return;
    const overlay = root.querySelector(".mf-pdf-export-overlay");
    if (overlay) {
      overlay.classList.add("mf-hidden");
      overlay.setAttribute("aria-hidden", "true");
    }
    if (pdfExportEscapeHandler) {
      document.removeEventListener("keydown", pdfExportEscapeHandler, true);
      pdfExportEscapeHandler = null;
    }
    const submitBtn = root.querySelector(".mf-pdf-export-submit");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Generate PDF";
    }
  }

  async function openPdfExportModal() {
    if (!root) return;
    if (!isProUser()) {
      showToast("Upgrade to Pro to export PDF reports.");
      return;
    }
    const clip = resolveClipContext();
    if (!clip) {
      showToast("No video context.");
      return;
    }
    if (!state.comments.length) {
      showToast("No comments to export.");
      return;
    }
    const overlay = root.querySelector(".mf-pdf-export-overlay");
    if (!overlay) return;
    await refreshCloudUser(false);
    const prefs = await loadCachedPreferences();
    const email = state.cloudUser?.email?.trim() || "";
    const rawRecord = await getClipRecordForDisplay(clip);
    const videoTitle = clipDisplayTitleFromRecord(rawRecord, clip);
    const projectInp = root.querySelector(".mf-pdf-export-project");
    const preparedByInp = root.querySelector(".mf-pdf-export-prepared-by");
    const preparedForInp = root.querySelector(".mf-pdf-export-prepared-for");
    const errEl = root.querySelector(".mf-pdf-export-error");
    const submitBtn = root.querySelector(".mf-pdf-export-submit");
    if (!projectInp || !preparedByInp || !preparedForInp || !submitBtn) return;
    projectInp.value = videoTitle;
    preparedByInp.value = pdfExportPreparedByLine(prefs, email);
    preparedForInp.value = "";
    if (errEl) {
      errEl.textContent = "";
      errEl.classList.add("mf-hidden");
    }
    submitBtn.disabled = false;
    submitBtn.textContent = "Generate PDF";
    overlay.classList.remove("mf-hidden");
    overlay.setAttribute("aria-hidden", "false");
    pdfExportEscapeHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePdfExportModal();
      }
    };
    document.addEventListener("keydown", pdfExportEscapeHandler, true);
    requestAnimationFrame(() => projectInp.focus());
  }

  async function submitPdfExportModal() {
    if (!root) return;
    const overlay = root.querySelector(".mf-pdf-export-overlay");
    if (!overlay || overlay.classList.contains("mf-hidden")) return;
    if (!isProUser()) {
      showToast("Upgrade to Pro to export PDF reports.");
      return;
    }
    const clip = resolveClipContext();
    if (!clip) {
      showToast("No video context.");
      return;
    }
    const projectInp = root.querySelector(".mf-pdf-export-project");
    const preparedByInp = root.querySelector(".mf-pdf-export-prepared-by");
    const preparedForInp = root.querySelector(".mf-pdf-export-prepared-for");
    const errEl = root.querySelector(".mf-pdf-export-error");
    const submitBtn = root.querySelector(".mf-pdf-export-submit");
    if (!projectInp || !preparedByInp || !preparedForInp || !submitBtn) return;
    if (submitBtn.textContent === "Generating...") return;
    const projectTrim = projectInp.value.trim();
    if (!projectTrim) {
      projectInp.focus();
      if (errEl) {
        errEl.textContent = "Project is required.";
        errEl.classList.remove("mf-hidden");
      }
      return;
    }
    if (errEl) {
      errEl.textContent = "";
      errEl.classList.add("mf-hidden");
    }
    await refreshCloudUser(false);
    const prefs = await loadCachedPreferences();
    const currentUser = {
      displayName: String(prefs.displayName || "").trim() || String(state.cloudUser?.email || "").trim(),
      companyName: String(prefs.companyName || "").trim(),
      logoDataUrl: prefs.logoDataUrl || "",
    };
    const nestedComments = buildNestedCommentsForPdfExport();
    const dur = getClipVideoDurationSecondsForExport(clip);
    const formattedDuration = formatVideoDurationForPdfExport(dur);
    submitBtn.disabled = true;
    submitBtn.textContent = "Generating...";
    try {
      console.log(
        "[Notch] PDF export payload:",
        JSON.stringify({
          project: projectInp.value,
          commentCount: nestedComments.length,
          comments: nestedComments.map((c) => ({
            id: c.id,
            text: String(c.text ?? "").substring(0, 30),
            hasFrameCapture: !!c.frameCapture && c.frameCapture.length > 0,
            frameCaptureLength: c.frameCapture ? c.frameCapture.length : 0,
          })),
        })
      );
      const res = await fetch("https://notch.video/.netlify/functions/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectInp.value,
          preparedBy: preparedByInp.value,
          preparedFor: preparedForInp.value,
          platform: clip.platform,
          videoDuration: formattedDuration,
          generatedDate: new Date().toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          studioName: currentUser.companyName || currentUser.displayName,
          logoDataUrl: currentUser.logoDataUrl || "",
          comments: nestedComments,
        }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {
        data = null;
      }
      if (!res.ok || !data || typeof data.pdf !== "string" || !data.pdf) {
        if (errEl) {
          errEl.textContent = "Failed to generate PDF. Please try again.";
          errEl.classList.remove("mf-hidden");
        }
        submitBtn.disabled = false;
        submitBtn.textContent = "Generate PDF";
        return;
      }
      const bin = atob(data.pdf);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeBase = String(projectInp.value || "Review").replace(/[/\\?%*:|"<>]/g, " ").trim() || "Review";
      a.download = `${safeBase} — Review.pdf`;
      a.rel = "noopener";
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      closePdfExportModal();
    } catch (_) {
      if (errEl) {
        errEl.textContent = "Failed to generate PDF. Please try again.";
        errEl.classList.remove("mf-hidden");
      }
      submitBtn.disabled = false;
      submitBtn.textContent = "Generate PDF";
    }
  }

  async function cropDataUrlToViewportRectPng(dataUrl, rectCss) {
    if (!dataUrl || !rectCss) return null;
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("img"));
      i.src = dataUrl;
    });
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!iw || !ih || !vw || !vh) return null;
    const scaleX = iw / vw;
    const scaleY = ih / vh;
    const sx = Math.max(0, Math.round(rectCss.left * scaleX));
    const sy = Math.max(0, Math.round(rectCss.top * scaleY));
    const sw = Math.max(1, Math.round(rectCss.width * scaleX));
    const sh = Math.max(1, Math.round(rectCss.height * scaleY));
    const c = document.createElement("canvas");
    c.width = sw;
    c.height = sh;
    const g = c.getContext("2d");
    if (!g) return null;
    try {
      g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    } catch (_) {
      return null;
    }
    try {
      return c.toDataURL("image/png");
    } catch (_) {
      return null;
    }
  }

  /**
   * Tab screenshots are composited: anything painted over the crop rect (other extensions, OS UI in
   * practice not included) appears in the grab. True decoded frame-only pixels require drawing from an
   * HTMLVideoElement when the browser allows it. Here we hide the Notch panel briefly so it does not
   * occlude Drive's player for the few frames we capture.
   */
  async function suppressExtensionUIPaintDuringCapture(asyncWork) {
    const nodes = [];
    const markFrame = document.getElementById("markframe-root");
    if (markFrame?.isConnected) nodes.push(markFrame);
    for (const n of nodes) {
      n.style.setProperty("visibility", "hidden", "important");
    }
    await new Promise((cb) => requestAnimationFrame(cb));
    await new Promise((cb) => requestAnimationFrame(cb));
    try {
      return await asyncWork();
    } finally {
      for (const n of nodes) {
        n.style.removeProperty("visibility");
      }
    }
  }

  /** @param {{ quiet?: boolean }} [options] quiet: no toasts (PDF multi-frame capture). */
  async function captureGoogleDriveVisibleTabPngDataUrl(options) {
    const quiet = options?.quiet === true;
    return suppressExtensionUIPaintDuringCapture(async () => {
      const r = getGoogleDriveScreengrabCropRect();
      if (!r) {
        if (!quiet) showToast("Could not find the video area on screen.");
        return null;
      }
      let resp;
      try {
        resp = await sendExtensionMessage({ type: "MF_CAPTURE_VISIBLE_TAB" });
      } catch (_) {
        resp = null;
      }
      if (!resp?.ok || !resp.dataUrl) {
        if (!quiet) {
          showToast(
            resp?.error || "Could not capture the tab — try closing other overlays and try again."
          );
        }
        return null;
      }
      const cropped = await cropDataUrlToViewportRectPng(resp.dataUrl, r);
      if (!cropped) {
        if (!quiet) showToast("Could not crop the capture.");
        return null;
      }
      return cropped;
    });
  }

  async function captureGoogleDriveFrameViaVisibleTab(options) {
    return captureGoogleDriveVisibleTabPngDataUrl(options);
  }

  async function captureCurrentVideoFrameBlob() {
    const clip = resolveClipContext();
    if (!clip) return null;
    const raw = clip.getVideoElement();

    if (clip.platform === "googledrive" && raw && !(raw instanceof HTMLVideoElement)) {
      const dataUrl = await captureGoogleDriveFrameViaVisibleTab();
      if (!dataUrl) return null;
      let blob;
      try {
        blob = await (await fetch(dataUrl)).blob();
      } catch (e) {
        showToast("Could not export frame (this site may block captures).");
        return null;
      }
      const t = Number.isFinite(raw.currentTime) ? raw.currentTime : 0;
      const base = `notch-frame_${sanitizeFilenamePart(clip.clipId)}_${formatTimestampForFilename(t)}`;
      return { blob, base };
    }

    if (!raw) {
      showToast("No video found.");
      return null;
    }
    if (!(raw instanceof HTMLVideoElement)) {
      showToast("Screengrab is not available for this embedded player.");
      return null;
    }
    if (!raw.isConnected) {
      showToast("No video found.");
      return null;
    }
    if (raw.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      showToast("Video not ready yet — try again in a moment.");
      return null;
    }
    const vw = raw.videoWidth;
    const vh = raw.videoHeight;
    if (!vw || !vh) {
      showToast("Could not read video frame.");
      return null;
    }
    let dataUrl = videoElementToPngDataUrl(raw);
    if (!dataUrl && clip.platform === "googledrive") {
      dataUrl = await captureGoogleDriveFrameViaVisibleTab();
    }
    if (!dataUrl) {
      showToast("Could not capture this video (protected content).");
      return null;
    }
    let blob;
    try {
      blob = await (await fetch(dataUrl)).blob();
    } catch (e) {
      showToast("Could not export frame (this site may block captures).");
      return null;
    }
    const t = Number.isFinite(raw.currentTime) ? raw.currentTime : 0;
    const base = `notch-frame_${sanitizeFilenamePart(clip.clipId)}_${formatTimestampForFilename(t)}`;
    return { blob, base };
  }

  async function downloadCurrentVideoFrame() {
    const got = await captureCurrentVideoFrameBlob();
    if (!got) return;
    const url = URL.createObjectURL(got.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${got.base}.png`;
    a.rel = "noopener";
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Frame downloaded.");
  }

  async function copyCurrentVideoFrameToClipboard() {
    const got = await captureCurrentVideoFrameBlob();
    if (!got) return;
    if (typeof ClipboardItem === "undefined") {
      showToast("Copy image is not supported in this browser.");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": got.blob })]);
      showToast("Frame copied to clipboard.");
    } catch (e) {
      showToast("Could not copy image to clipboard.");
    }
  }

  async function copyReviewLink() {
    if (!isProUser()) {
      showToast("Upgrade to Pro to copy review links.");
      return;
    }
    const clip = resolveClipContext();
    if (!clip) return;
    if (!isCloudActive()) {
      showToast("Sign in to copy a review link.");
      return;
    }
    if (!(await getSupabaseConfigured())) {
      showToast("Cloud is not configured.");
      return;
    }
    try {
      await refreshCloudUser(false);
      const hostSupabaseUserId = String(state.cloudUser?.id || "").trim();
      if (!hostSupabaseUserId) {
        showToast("Sign in to copy a review link.");
        return;
      }
      const r = await sendExtensionMessage({
        type: "MF_ENSURE_CLIP_REVIEW_ROW",
        platform: clip.platform,
        clipId: clip.clipId,
      });
      const rowHostId = String(r?.hostUserId ?? r?.userId ?? "").trim();
      if (
        !r?.ok ||
        !r.platform ||
        r.clipId == null ||
        String(r.clipId) === "" ||
        !rowHostId ||
        normalizeUuidForCompare(rowHostId) !== normalizeUuidForCompare(hostSupabaseUserId)
      ) {
        const err = r?.error || "";
        if (err === "not_authenticated") showToast("Sign in to copy a review link.");
        else if (err === "pro_required") showToast("Upgrade to Pro to copy review links.");
        else showToast("Could not prepare review link.");
        return;
      }
      const qs = new URLSearchParams({
        uid: hostSupabaseUserId,
        platform: String(r.platform),
        clip: String(r.clipId),
      });
      const url = `https://notch.video/review?${qs.toString()}`;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.documentElement.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      showToast("Review link copied to clipboard.");
    } catch (err) {
      showToast("Could not copy link.");
    }
  }

  async function tryImportFromUrl(clip) {
    if (!clip) return;
    let param = null;
    try {
      const u = new URL(location.href);
      param = u.searchParams.get(MF_PARAM);
    } catch {
      return;
    }
    if (!param) return;
    try {
      const data = await decompressFromBase64Url(param);
      if (!Array.isArray(data.comments)) return;
      if (data.v === 2) {
        if (data.platform !== clip.platform || data.clipId !== clip.clipId) return;
      } else if (data.videoId != null) {
        if (clip.platform !== "youtube" || data.videoId !== clip.clipId) return;
      } else {
        return;
      }
      const imported = data.comments;
      normalizeCommentListShape(imported);
      const ok = await saveClipData(clip, { comments: imported });
      if (!ok) {
        showToast("Could not save imported review to the cloud.");
        return;
      }
      state.comments = imported;
      state.collapsedReplyRoots.clear();
      normalizeCommentsShape();
      await Promise.all([refreshAuthorPresentationCache(), refreshTimestampFormatCache()]);
      renderThread();
      showToast("Imported review from link.");
      const u = new URL(location.href);
      u.searchParams.delete(MF_PARAM);
      history.replaceState(null, "", u.toString());
    } catch (e) {}
  }

  async function initReview(clip) {
    const mount = document.body || document.documentElement;
    if (!mount) return;

    clearState1TitleRetryPoll();

    if (root && root.parentNode !== mount) {
      mount.appendChild(root);
    }

    applyCompactRootLayout();

    const clipChanged = activeClipStorageKey !== clip.storageKey;
    if (clipChanged) {
      teardownCanvas();
      activeClipStorageKey = clip.storageKey;
    }
    const willLoadClipData =
      clipChanged || isCloudActive() || isGuestSharedReviewActive();
    if (willLoadClipData) {
      applyWatchReviewUiPhase("loading", clip);
    }
    try {
      if (clipChanged || isCloudActive() || isGuestSharedReviewActive()) {
        await loadClipData(clip);
        await tryImportFromUrl(clip);
      }
      updateWatchChromeForReviewMode(clip);
      await mergeClipMetadata(clip);
      await refreshWatchVideoTitle(clip);
      await updateWatchHeaderSub(clip);
    } finally {
      if (root && root.dataset.mfReviewUi === "loading") {
        updateWatchChromeForReviewMode(clip);
      }
    }
    await maybeStartState1TitleRetryPoll(clip);

    root.classList.toggle("mf-collapsed", state.collapsed);

    await Promise.all([refreshAuthorPresentationCache(), refreshTimestampFormatCache()]);
    renderThread();
    if (isGuestSharedReviewActive()) {
      startGuestSharedPoll();
    } else {
      clearGuestSharedPoll();
    }
    refreshProGatedToolbar();
    const hostUserId = await getCloudLoadSaveHostUserId(clip);
    void sendExtensionMessage({
      type: "MF_CLOUD_SUBSCRIBE_CLIP_REACTIONS",
      platform: clip.platform,
      clipId: clip.clipId,
      ...(hostUserId ? { hostUserId } : {}),
    }).catch(() => {});

    ensureCanvasOverlay(clip);
    videoEl = clip.getVideoElement();
  }

  let openSharedReviewDedupAt = 0;

  /** Ensures clip_review_collaborators has a row so RLS allows reading the host's notes (share link flow). */
  async function ensureSharedReviewCollaboratorMembership(hostUserId, clip) {
    const hid = String(hostUserId || "").trim();
    if (!hid || !clip) return { ok: false, error: "invalid_args" };
    await refreshCloudUser(false);
    const myId = state.cloudUser?.id && String(state.cloudUser.id).trim();
    if (!myId) return { ok: false, error: "not_authenticated" };
    if (normalizeUuidForCompare(hid) === normalizeUuidForCompare(myId)) {
      return { ok: true, isHost: true };
    }
    try {
      const r = await sendExtensionMessage({
        type: "MF_JOIN_SHARED_REVIEW",
        hostUserId: hid,
        platform: clip.platform,
        clipId: clip.clipId,
      });
      if (r?.ok === true) return { ok: true, isHost: !!r.isHost };
      return { ok: false, error: String(r?.error || "join_failed") };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function patchNotchSharedReviewStorage(patch) {
    const curRaw = await safeStorageLocalGet("notch_shared_review");
    const cur = curRaw.notch_shared_review;
    const base = cur && typeof cur === "object" ? { ...cur } : {};
    await safeStorageLocalSet({ notch_shared_review: { ...base, ...patch } });
  }

  async function handleOpenSharedReview(msg) {
    const uid = String(msg.uid || "").trim();
    const platform = msg.platform;
    const sharedClipId = msg.clip != null ? String(msg.clip) : "";
    if (!uid || !platform || !sharedClipId) return;

    const now = Date.now();
    if (now - openSharedReviewDedupAt < 800) return;
    openSharedReviewDedupAt = now;

    try {
      sessionStorage.removeItem(SESSION_KEY_SIDEBAR_HIDDEN);
      sessionStorage.setItem(SESSION_KEY_SIDEBAR_POPUP_OPEN, "1");
    } catch {
      /* ignore */
    }
    await setGlobalVisibility(true);

    const clip = resolveClipContext();
    if (!clip) {
      showToast("Open the matching video page to load this review.");
      return;
    }
    if (!clipMatchesRedeemTarget(clip, platform, sharedClipId)) {
      showToast("Open the matching video page to load this review.");
      return;
    }

    await refreshCloudUser(false);
    const myId = state.cloudUser?.id && String(state.cloudUser.id).trim();
    if (myId && normalizeUuidForCompare(uid) === normalizeUuidForCompare(myId)) {
      await clearCollabHostForClip(clip);
      await patchNotchSharedReviewStorage({ needsDbJoin: false });
    } else {
      await setCollabHostForRedeem(clip.platform, clip.clipId, uid);

      if (!isCloudActive()) {
        await patchNotchSharedReviewStorage({ needsDbJoin: true });
      } else {
        const j = await ensureSharedReviewCollaboratorMembership(uid, clip);
        if (j.ok) {
          await patchNotchSharedReviewStorage({ needsDbJoin: false });
        } else {
          const err = j.error || "";
          if (err === "not_authenticated") {
            await patchNotchSharedReviewStorage({ needsDbJoin: true });
          } else {
            if (err === "no_review") {
              showToast("This review is not available in the cloud yet.");
            } else {
              showToast("Could not join this shared review.");
            }
            await patchNotchSharedReviewStorage({ needsDbJoin: false });
          }
        }
      }
    }

    lastTickSignature = "";
    await tick();
    showToast("Loaded shared review.");
  }

  function storageOnChanged(changes, area) {
    if (area === "local") {
      if (changes[GLOBAL_STATE_KEYS.isVisible]) {
        globalPanelState.isVisible = changes[GLOBAL_STATE_KEYS.isVisible].newValue !== false;
        void (async () => {
          try {
            const effective = await resolveEffectiveSidebarVisible(
              globalPanelState.isVisible,
              lastSidebarVisibilityContext
            );
            applySidebarDomFromEffective(effective);
          } catch (e) {
            if (!isExtensionContextInvalidated(e) && typeof console !== "undefined" && console.error) {
              console.error(e);
            }
          }
        })();
      } else if (changes[STORAGE_KEYS.sidebarVisible] && !changes[GLOBAL_STATE_KEYS.isVisible]) {
        globalPanelState.isVisible = changes[STORAGE_KEYS.sidebarVisible].newValue !== false;
        void (async () => {
          try {
            const effective = await resolveEffectiveSidebarVisible(
              globalPanelState.isVisible,
              lastSidebarVisibilityContext
            );
            applySidebarDomFromEffective(effective);
          } catch (e) {
            if (!isExtensionContextInvalidated(e) && typeof console !== "undefined" && console.error) {
              console.error(e);
            }
          }
        })();
      }
      if (changes[GLOBAL_STATE_KEYS.activePanelView]) {
        const nextView = normalizeActivePanelView(changes[GLOBAL_STATE_KEYS.activePanelView].newValue);
        globalPanelState.activePanelView = nextView;
        if (nextView === "settings") {
          void openSettingsPanel({ persistGlobal: false });
        } else {
          void closeSettingsPanel({ persistGlobal: false });
        }
      }
      if (changes[STORAGE_KEYS.panelCorner]) {
        applyPanelCorner(changes[STORAGE_KEYS.panelCorner].newValue);
      }
      if (changes[STORAGE_KEYS.autoPauseCommentTyping]) {
        applyAutoPauseCommentTypingPref(changes[STORAGE_KEYS.autoPauseCommentTyping].newValue);
      }
      if (changes[PREFS_STORAGE_KEY]) {
        const next = normalizePreferences(changes[PREFS_STORAGE_KEY].newValue || {});
        cachedPreferences = next;
        applyPanelCorner(normalizePanelPosition(next.panelPosition));
        applyAutoPauseCommentTypingPref(next.autoPause);
        applyFloatPanelPref(!!next.floatPanel);
        cachedTimestampFormat = next.timestampFormat === "long" ? "00:00:39" : "0:39";
      }
      if (changes[PREFS_STORAGE_KEY]) {
        void refreshAuthorPresentationCache()
          .then(() => {
            if (root && root.dataset.mfReviewUi === "active" && root.dataset.mfLocked !== "1") renderThread();
          })
          .catch(() => {});
      }
      if (
        changes[STORAGE_KEYS.authState] ||
        changes[SUPABASE_AUTH_STORAGE_KEY] ||
        changes[SUPABASE_AUTH_STORAGE_KEY + "-user"]
      ) {
        cloudAuthCacheValidUntil = 0;
        lastTickSignature = "";
        void refreshCloudUser(true)
          .then(async () => {
            await refreshPreferencesFromSupabase();
            await refreshTimestampFormatCache();
            await refreshAuthorPresentationCache();
            await tick();
          })
          .catch((e) => {
            if (!isExtensionContextInvalidated(e) && typeof console !== "undefined" && console.error) {
              console.error(e);
            }
          });
      }
      return;
    }
    if (area === "sync" && changes[SYNC_KEY_AUTO_SHOW_SIDEBAR]) {
      lastTickSignature = "";
      void tick();
    }
  }

  async function tick() {
    try {
      await tickInner();
    } catch (e) {
      if (isExtensionContextInvalidated(e)) return;
    }
  }

  async function tickInner() {
    const href = location.href;
    const clip = resolveClipContext();
    hasSupportedClipOnPage = !!clip;

    await refreshCloudUser(false);
    if (state.cloudUser) guestAuthRouteGate = false;

    let supabaseConfigured = false;
    try {
      const cfg = await sendExtensionMessage({ type: "MF_SUPABASE_CONFIG" });
      supabaseConfigured = !!cfg?.configured;
    } catch {
      supabaseConfigured = false;
    }

    await syncGuestSessionForClip(clip);

    const collabHostOnClip = clip ? String((await readCollabHostUserIdForClip(clip)) || "").trim() : "";

    const unlocked = supabaseConfigured && !!state.cloudUser;
    const guestUnlocked =
      supabaseConfigured &&
      !state.cloudUser &&
      !!String(state.guestSession?.guestName || "").trim() &&
      !!collabHostOnClip &&
      !!clip;
    const guestInvite =
      supabaseConfigured &&
      !state.cloudUser &&
      !!clip &&
      !!collabHostOnClip &&
      !String(state.guestSession?.guestName || "").trim() &&
      !guestAuthRouteGate;
    const shellUnlocked = unlocked || guestUnlocked;

    console.log(
      "[Notch debug] tickInner: shellUnlocked=" +
        shellUnlocked +
        " cloudUser=" +
        !!state.cloudUser +
        " clip=" +
        !!clip +
        " supabaseConfigured=" +
        supabaseConfigured
    );

    const mount = document.body || document.documentElement;
    if (!mount) return;

    let collabPart = "";
    if (clip && shellUnlocked) {
      collabPart = collabHostOnClip || "";
    }

    const { notch_shared_review: nsr } = await safeStorageLocalGet("notch_shared_review");
    if (
      unlocked &&
      clip &&
      nsr &&
      nsr.needsDbJoin &&
      clipMatchesRedeemTarget(clip, nsr.platform, String(nsr.clip ?? ""))
    ) {
      const host = await readCollabHostUserIdForClip(clip);
      if (host && normalizeUuidForCompare(host) === normalizeUuidForCompare(String(nsr.uid || ""))) {
        const j = await ensureSharedReviewCollaboratorMembership(nsr.uid, clip);
        if (j.ok) {
          await patchNotchSharedReviewStorage({ needsDbJoin: false });
          lastTickSignature = "";
        }
      }
    }

    const overlaySig = !clip
      ? ""
      : typeof clip.getOverlayParent === "function" && clip.getOverlayParent()
        ? "ov1"
        : "ov0";

    const guestNameSig = String(state.guestSession?.guestName || "").trim();
    const noOwnerRowSig = clip && shellUnlocked ? (state.noOwnerReviewRow ? "1" : "0") : "";
    const sig = shellUnlocked
      ? !clip
        ? href + "\0no_clip"
        : href +
          "\0" +
          clip.storageKey +
          "\0" +
          collabPart +
          "\0watch\0" +
          overlaySig +
          "\0" +
          guestNameSig +
          "\0nor" +
          noOwnerRowSig
      : href +
          "\0gate\0" +
          String(supabaseConfigured) +
          "\0gi" +
          String(guestInvite ? 1 : 0) +
          "\0gag" +
          String(guestAuthRouteGate ? 1 : 0);

    if (sig === lastTickSignature) return;
    lastTickSignature = sig;

    if (!root) {
      root = buildSidebarHtml();
      mount.appendChild(root);
      wireSidebar();
    } else if (root.parentNode !== mount) {
      mount.appendChild(root);
    }

    applyCompactRootLayout();
    updateGateCopy(supabaseConfigured);

    if (guestInvite) {
      lastSidebarVisibilityContext = { guestInvite: true, shellUnlocked: false, hasClip: !!clip };
      void sendExtensionMessage({ type: "MF_CLOUD_UNSUBSCRIBE_CLIP_REACTIONS" }).catch(() => {});
      clearGuestSharedPoll();
      clearState1TitleRetryPoll();
      teardownDriveYoutubeEmbedBridge();
      teardownCanvas();
      activeClipStorageKey = null;
      state.comments = [];
      state.selectedId = null;
      state.replyTargetId = null;
      state.collapsedReplyRoots.clear();
      state.drawMode = false;
      syncRootChromeVisibility({ guestInvite: true, unlocked: false });
      await applySidebarLayoutFromStorage();
      root.classList.toggle("mf-collapsed", state.collapsed);
      void updateGuestInviteSubtitle(clip);
      return;
    }

    lastSidebarVisibilityContext = {
      guestInvite: false,
      shellUnlocked: !!shellUnlocked,
      hasClip: !!clip,
    };
    syncRootChromeVisibility({ guestInvite: false, unlocked: shellUnlocked });

    await applySidebarLayoutFromStorage();
    root.classList.toggle("mf-collapsed", state.collapsed);

    if (!shellUnlocked) {
      void sendExtensionMessage({ type: "MF_CLOUD_UNSUBSCRIBE_CLIP_REACTIONS" }).catch(() => {});
      clearGuestSharedPoll();
      clearState1TitleRetryPoll();
      teardownDriveYoutubeEmbedBridge();
      teardownCanvas();
      activeClipStorageKey = null;
      state.comments = [];
      state.selectedId = null;
      state.replyTargetId = null;
      state.collapsedReplyRoots.clear();
      state.drawMode = false;
      return;
    }

    if (!clip) {
      void sendExtensionMessage({ type: "MF_CLOUD_UNSUBSCRIBE_CLIP_REACTIONS" }).catch(() => {});
      clearGuestSharedPoll();
      clearState1TitleRetryPoll();
      teardownDriveYoutubeEmbedBridge();
      if (activeClipStorageKey) {
        teardownCanvas();
        activeClipStorageKey = null;
      }
      state.comments = [];
      state.selectedId = null;
      state.replyTargetId = null;
      state.collapsedReplyRoots.clear();
      state.drawMode = false;
      return;
    }

    if (clip.platform !== "googledrive") {
      teardownDriveYoutubeEmbedBridge();
    }

    await initReview(clip);
  }

  /** Clear watch/start title UI so the previous video's label does not linger during SPA transitions. */
  function resetYoutubeWatchTitleChromeForSpaNavigation() {
    if (!root || !isYoutubeSite()) return;
    const clip = resolveClipContext();
    const shell = root.querySelector(".mf-app-shell");
    if (
      clip &&
      shell &&
      !shell.classList.contains("mf-hidden") &&
      root.dataset.mfLocked !== "1" &&
      root.dataset.mfGuestInviteOpen !== "1"
    ) {
      applyWatchReviewUiPhase("loading", clip);
    }
    const placeholder = clip ? defaultClipDisplayTitle(clip) : "Video";
    const headerTitle = root.querySelector(".mf-watch-header-title");
    if (headerTitle) {
      headerTitle.textContent = placeholder;
      headerTitle.setAttribute("title", placeholder);
    }
    const startTitle = root.querySelector(".mf-start-review-title");
    const startSkel = root.querySelector(".mf-start-review-title-row .mf-title-skeleton");
    if (!startTitle || !startSkel) return;
    startTitle.textContent = placeholder;
    startTitle.setAttribute("title", placeholder);
    if (root.dataset.mfReviewUi === "start") {
      startTitle.classList.add("mf-hidden");
      startSkel.classList.remove("mf-hidden");
    }
  }

  let youtubeWatchPipelineResyncTid = null;

  /**
   * YouTube watch is an SPA: URL and DOM/meta update without a full reload. Invalidate tick dedupe,
   * drop cached active clip so initReview reloads row + metadata, reset visible titles, and rerun tick
   * after a short delay so og:url / og:title match the new video.
   */
  function scheduleYoutubeWatchPipelineResync() {
    if (!isYoutubeSite()) return;
    console.log("pipeline resync scheduled", location.href);
    lastTickSignature = "";
    clearState1TitleRetryPoll();
    activeClipStorageKey = null;
    resetYoutubeWatchTitleChromeForSpaNavigation();
    if (youtubeWatchPipelineResyncTid != null) {
      clearTimeout(youtubeWatchPipelineResyncTid);
    }
    youtubeWatchPipelineResyncTid = setTimeout(() => {
      youtubeWatchPipelineResyncTid = null;
      void tick();
    }, 120);
  }

  function startUrlWatcher() {
    let last = location.href;
    const check = () => {
      if (location.href !== last) {
        last = location.href;
        void tick();
      }
    };
    setInterval(check, 800);
    const onYtNavigateFinish = () => {
      console.log("yt-navigate-finish fired", location.href);
      last = location.href;
      scheduleYoutubeWatchPipelineResync();
    };
    const onYtPageDataUpdated = () => {
      console.log("yt-page-data-updated fired", location.href);
      last = location.href;
      scheduleYoutubeWatchPipelineResync();
    };
    document.addEventListener("yt-navigate-finish", onYtNavigateFinish);
    document.addEventListener("yt-page-data-updated", onYtPageDataUpdated);
  }

  chrome.runtime.onMessage.addListener((msg, _e, sendResponse) => {
    if (msg && msg.type === "MF_GET_SIDEBAR_STATE") {
      sendResponse({
        isVisible: !sessionStorage.getItem(SESSION_KEY_SIDEBAR_HIDDEN),
      });
      return false;
    }
    if (msg && msg.type === "MF_POPUP_SET_SIDEBAR_TAB_HIDDEN") {
      const hidden = msg.hidden === true;
      if (hidden) {
        hideSidebarForThisTab();
      } else {
        try {
          sessionStorage.removeItem(SESSION_KEY_SIDEBAR_HIDDEN);
          sessionStorage.setItem(SESSION_KEY_SIDEBAR_POPUP_OPEN, "1");
        } catch {
          /* ignore */
        }
        void (async () => {
          const eff = await resolveEffectiveSidebarVisible(
            globalPanelState.isVisible,
            lastSidebarVisibilityContext
          );
          applySidebarDomFromEffective(eff);
        })();
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === "NOTCH_REVEAL_SIDEBAR") {
      try {
        sessionStorage.removeItem(SESSION_KEY_SIDEBAR_HIDDEN);
        sessionStorage.setItem(SESSION_KEY_SIDEBAR_POPUP_OPEN, "1");
      } catch {
        /* ignore */
      }
      void setGlobalVisibility(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg && msg.type === "TOGGLE_SIDEBAR") {
      loadGlobalPanelState().then((s) => {
        const next = !s.isVisible;
        if (next) {
          try {
            sessionStorage.removeItem(SESSION_KEY_SIDEBAR_HIDDEN);
            sessionStorage.setItem(SESSION_KEY_SIDEBAR_POPUP_OPEN, "1");
          } catch {
            /* ignore */
          }
        }
        setGlobalVisibility(next).then(() => sendResponse({ ok: true, sidebarVisible: next }));
      });
      return true;
    }
    if (msg && msg.type === "NOTCH_STATE_UPDATE" && msg.state) {
      const incoming = {
        isVisible: msg.state.isVisible !== false,
        activePanelView: normalizeActivePanelView(msg.state.activePanelView),
      };
      globalPanelState = incoming;
      void (async () => {
        const effective = await resolveEffectiveSidebarVisible(
          incoming.isVisible,
          lastSidebarVisibilityContext
        );
        applySidebarDomFromEffective(effective);
      })();
      if (incoming.activePanelView === "settings") {
        void openSettingsPanel({ persistGlobal: false });
      } else {
        void closeSettingsPanel({ persistGlobal: false });
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.action === "open-shared-review") {
      void handleOpenSharedReview(msg)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    if (msg && msg.type === "MF_CLOUD_CLIP_UPDATED" && msg.record) {
      if (pendingReactionSaves > 0) {
        sendResponse({ ok: true, skipped: "pending_local_save" });
        return false;
      }
      const list = coerceIncomingComments(msg.record);
      if (list !== null) {
        state.comments = list;
        applyOwnIdentityToLoadedComments();
        normalizeCommentsShape();
        invalidateReactionPublicNamesCache();
        renderThread();
      }
      sendResponse({ ok: true });
      return false;
    }
  });

  const mo = new MutationObserver(() => {
    clearTimeout(urlCheckTimer);
    urlCheckTimer = setTimeout(() => void tick(), 300);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(storageOnChanged);

  void loadCachedPreferences()
    .then(() => refreshTimestampFormatCache())
    .then(() => refreshAuthorPresentationCache())
    .then(() => refreshPreferencesFromSupabase())
    .catch(() => {});

  let compactLayoutResizeTid = null;
  window.addEventListener("resize", () => {
    clearTimeout(compactLayoutResizeTid);
    compactLayoutResizeTid = setTimeout(() => applyCompactRootLayout(), 150);
  });

  startUrlWatcher();
  void tick();
})();
