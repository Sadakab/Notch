(function () {
  "use strict";

  if (window !== window.top) return;

  const ACCENT = "#00E5FF";
  /** Set true to show Draw / color / save, overlay canvas, and drawing thumbnails. */
  const FEATURE_DRAWING = false;
  /** Page console: filter `[Notch]` — cloud load/save diagnostics. Set false to silence. */
  const NOTCH_DIAG = true;
  function notchLog(msg, detail) {
    if (!NOTCH_DIAG) return;
    if (detail !== undefined) {
      const extra =
        detail && typeof detail === "object"
          ? JSON.stringify(detail)
          : String(detail);
      console.log("[Notch]", msg, extra);
    } else {
      console.log("[Notch]", msg);
    }
  }
  /** Must match service worker Supabase auth storageKey. */
  const SUPABASE_AUTH_STORAGE_KEY = "sb-notch-auth";

  const STORAGE_KEYS = {
    author: "markframe_author",
    /** Data URL (small JPEG) or https:// image URL for comment avatars. */
    avatar: "markframe_avatar",
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
    const o = await chrome.storage.local.get(keys);
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
    await chrome.storage.local.set({ [collabHostStorageKey(platform, clipId)]: hid });
  }

  async function clearCollabHostForClip(clip) {
    if (!clip) return;
    const keys = collabHostKeysToTry(clip.platform, clip.clipId);
    await chrome.storage.local.remove(keys);
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
    const all = await chrome.storage.local.get(null);
    const removals = Object.keys(all).filter((k) => k.startsWith("markframe_collab_host_"));
    if (removals.length) await chrome.storage.local.remove(removals);
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
    const sub = root.querySelector(".mf-header-sub");
    if (!sub || root.dataset.mfView !== "watch") return;
    const h = await readCollabHostUserIdForClip(clip);
    if (!h || !String(h).trim()) {
      sub.textContent = "";
      return;
    }
    await refreshCloudUser(false);
    const myId = state.cloudUser?.id && String(state.cloudUser.id).trim();
    if (myId && normalizeUuidForCompare(h) === normalizeUuidForCompare(myId)) {
      sub.textContent = "";
      return;
    }
    sub.textContent = "Shared review";
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
  let settingsAvatarPendingDataUrl = null;
  let settingsAvatarExplicitClear = false;
  /** Sync cache for renderThread (display name + avatar URL). */
  let cachedEffectiveDisplayName = "";
  let cachedAuthorAvatarUrl = "";
  /** Skip redundant init when DOM mutations fire but URL / clip / panel mode are unchanged (avoids panel flicker). */
  let lastTickSignature = "";
  /** At most one delayed reload per storageKey when shared-review binding exists but host row not returned yet. */
  const sharedReviewCloudReloadOnce = new Set();
  /** Bumps on each dashboard paint; stale async completions skip DOM so concurrent renders cannot duplicate rows. */
  let dashboardRenderGeneration = 0;
  /** Full storage key for the clip currently loaded in the review panel (e.g. markframe_clip_youtube_…). */
  let activeClipStorageKey = null;
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
    dashboardForced: false,
    /** When non-null, clip library reads/writes go to Supabase ({ email }). */
    cloudUser: null,
  };

  let cloudAuthCacheValidUntil = 0;
  let cloudAuthCachedUser = null;

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

  async function refreshCloudUser(force) {
    const now = Date.now();
    if (!force && now < cloudAuthCacheValidUntil) {
      state.cloudUser = cloudAuthCachedUser;
      return;
    }
    try {
      const r = await sendExtensionMessage({ type: "MF_SUPABASE_SESSION" });
      if (!r?.configured) {
        cloudAuthCachedUser = null;
        state.cloudUser = null;
        cloudAuthCacheValidUntil = 0;
        return;
      }
      cloudAuthCachedUser =
        r.user && (r.user.email || r.user.id)
          ? { email: r.user.email || "", id: r.user.id || "" }
          : null;
      state.cloudUser = cloudAuthCachedUser;
      cloudAuthCacheValidUntil = now + 45_000;
    } catch {
      cloudAuthCachedUser = null;
      state.cloudUser = null;
      cloudAuthCacheValidUntil = 0;
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

  function isCloudActive() {
    return !!state.cloudUser;
  }

  async function updateSyncBar() {
    if (!root) return;
    const syncEl = root.querySelector(".mf-header-sync-msg");
    const signOutRow = root.querySelector(".mf-settings-sign-out-row");
    if (syncEl) {
      if (root.dataset.mfView === "dashboard" && state.cloudUser?.email) {
        syncEl.textContent = state.cloudUser.email;
      } else {
        syncEl.textContent = "";
      }
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

  function gateAuthTabMode() {
    if (!root) return "sign-in";
    return root.dataset.mfGateAuthTab === "sign-up" ? "sign-up" : "sign-in";
  }

  function syncGateAuthTab(mode) {
    if (!root) return;
    const isSignUp = mode === "sign-up";
    root.dataset.mfGateAuthTab = mode;
    root.querySelectorAll(".mf-gate-tab").forEach((btn) => {
      const tab = btn.getAttribute("data-gate-tab");
      const active = tab === "sign-up" ? isSignUp : !isSignUp;
      btn.classList.toggle("mf-gate-tab-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    const fields = root.querySelector("#mf-gate-fields");
    if (fields) {
      fields.setAttribute("aria-labelledby", isSignUp ? "mf-gate-tab-sign-up" : "mf-gate-tab-sign-in");
    }
    const signupOnly = root.querySelector(".mf-gate-signup-only");
    if (signupOnly) signupOnly.classList.toggle("mf-hidden", !isSignUp);
    const btnIn = root.querySelector(".mf-gate-btn-signin");
    const btnUp = root.querySelector(".mf-gate-btn-signup");
    if (btnIn) btnIn.classList.toggle("mf-hidden", isSignUp);
    if (btnUp) btnUp.classList.toggle("mf-hidden", !isSignUp);
    const pass = root.querySelector(".mf-gate-password");
    if (pass) pass.setAttribute("autocomplete", isSignUp ? "new-password" : "current-password");
  }

  async function submitGateSignIn() {
    if (!root) return;
    const email = (root.querySelector(".mf-gate-email") || {}).value?.trim() || "";
    const password = (root.querySelector(".mf-gate-password") || {}).value || "";
    setGateStatus("");
    setGateFormBusy(true);
    try {
      const r = await sendExtensionMessage({
        type: "MF_AUTH_SIGN_IN",
        email,
        password,
      });
      if (!r?.ok) {
        setGateStatus(r?.error || "Sign in failed.", "err");
        return;
      }
      cloudAuthCacheValidUntil = 0;
      lastTickSignature = "";
      await refreshCloudUser(true);
      void tick();
    } catch (e) {
      setGateStatus(String(e.message || e), "err");
    } finally {
      setGateFormBusy(false);
    }
  }

  async function submitGateSignUp() {
    if (!root) return;
    const email = (root.querySelector(".mf-gate-email") || {}).value?.trim() || "";
    const password = (root.querySelector(".mf-gate-password") || {}).value || "";
    const confirm = (root.querySelector(".mf-gate-password-confirm") || {}).value || "";
    setGateStatus("");
    if (!email || !password) {
      setGateStatus("Enter email and password.", "err");
      return;
    }
    if (password.length < 6) {
      setGateStatus("Password must be at least 6 characters.", "err");
      return;
    }
    if (password !== confirm) {
      setGateStatus("Passwords do not match.", "err");
      return;
    }
    setGateFormBusy(true);
    try {
      const r = await sendExtensionMessage({
        type: "MF_AUTH_SIGN_UP",
        email,
        password,
      });
      if (!r?.ok) {
        setGateStatus(r?.error || "Sign up failed.", "err");
        return;
      }
      if (r.needsEmailConfirm) {
        setGateStatus(r.message || "Check your email, then sign in.", "ok");
        return;
      }
      cloudAuthCacheValidUntil = 0;
      lastTickSignature = "";
      await refreshCloudUser(true);
      void tick();
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
      msgEl.textContent = "Choose Log in or Sign up, then enter your email and password.";
      form.classList.remove("mf-hidden");
    }
  }

  function applyAppShellLocked(locked) {
    if (!root) return;
    root.dataset.mfLocked = locked ? "1" : "";
    const gate = root.querySelector(".mf-gate-pane");
    const shell = root.querySelector(".mf-app-shell");
    if (gate) gate.classList.toggle("mf-hidden", !locked);
    if (shell) shell.classList.toggle("mf-hidden", !!locked);
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

  /**
   * Only return title/thumb when page signals match `expectedVideoId` (SPA often leaves stale og tags).
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

    if (!pageVid || pageVid !== expectedVideoId) {
      return { title: null, thumbnailUrl: null, trusted: false, staleThumb: false };
    }

    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content");

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

    let title = (ogTitle || document.title || "").trim();
    title = title.replace(/\s*[-–—]\s*YouTube\s*$/i, "").trim();

    return {
      title: title || null,
      thumbnailUrl,
      trusted: true,
      staleThumb,
    };
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
    let title = (ogTitle || document.title || "").trim();
    title = title.replace(/\s*[-–—]\s*YouTube\s*$/i, "").trim();
    return {
      title: title || null,
      thumbnailUrl,
      trusted: true,
      staleThumb,
    };
  }

  function scrapeYoutubeClipMetadata(expectedVideoId) {
    const watchMeta = scrapeWatchPageMetadata(expectedVideoId);
    if (watchMeta.trusted) return watchMeta;
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

  /** Display name from a stored clip record (dashboard, library rows — no live page scrape). */
  function clipDisplayTitleFromStorage(v, platform) {
    if (v?.title != null && String(v.title).trim()) {
      return String(v.title).trim();
    }
    return defaultClipDisplayTitle({ platform });
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
    const { [clip.storageKey]: raw } = await chrome.storage.local.get(clip.storageKey);
    return raw ?? null;
  }

  async function refreshWatchVideoTitle(clip) {
    if (!root || !clip) return;
    const el = root.querySelector(".mf-watch-video-title");
    if (!el) return;

    const raw = await getClipRecordForDisplay(clip);
    const title = clipDisplayTitleFromRecord(raw, clip);

    if (el.textContent !== title) {
      el.textContent = title;
    }
    el.setAttribute("title", title);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const pad = (n) => String(n).padStart(2, "0");
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
    await chrome.storage.local.remove(localClipCacheKeys(clip));
  }

  /** Stored display-name override; empty string means use account email or "You". */
  async function loadAuthorOverride() {
    const { [STORAGE_KEYS.author]: name } = await chrome.storage.local.get(STORAGE_KEYS.author);
    return typeof name === "string" ? name : "";
  }

  async function saveAuthorOverride(override) {
    await chrome.storage.local.set({ [STORAGE_KEYS.author]: override });
  }

  async function effectiveDisplayName() {
    await refreshCloudUser(false);
    const raw = (await loadAuthorOverride()).trim();
    if (raw) return raw;
    const em = state.cloudUser?.email?.trim();
    if (em) return em;
    return "You";
  }

  async function refreshAuthorPresentationCache() {
    await refreshCloudUser(false);
    cachedEffectiveDisplayName = await effectiveDisplayName();
    const { [STORAGE_KEYS.avatar]: av } = await chrome.storage.local.get(STORAGE_KEYS.avatar);
    cachedAuthorAvatarUrl = typeof av === "string" && av.trim() ? av.trim() : "";
  }

  async function loadStoredAvatar() {
    const { [STORAGE_KEYS.avatar]: v } = await chrome.storage.local.get(STORAGE_KEYS.avatar);
    return typeof v === "string" && v.trim() ? v.trim() : "";
  }

  /** Keep under Chrome storage per-item limits (~8KB JSON). */
  const AVATAR_DATA_URL_MAX_LEN = 7000;

  function compressAvatarFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith("image/")) {
        reject(new Error("Choose an image file."));
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxPx = 72;
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
          let q = 0.82;
          let data = canvas.toDataURL("image/jpeg", q);
          while (data.length > AVATAR_DATA_URL_MAX_LEN && q > 0.28) {
            q -= 0.08;
            data = canvas.toDataURL("image/jpeg", q);
          }
          if (data.length > AVATAR_DATA_URL_MAX_LEN) {
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

  function resetSettingsAvatarFormState() {
    settingsAvatarPendingDataUrl = null;
    settingsAvatarExplicitClear = false;
    if (!root) return;
    const fileInp = root.querySelector(".mf-settings-avatar-file");
    if (fileInp) fileInp.value = "";
  }

  async function openSettingsPanel() {
    if (!root) return;
    const overlay = root.querySelector(".mf-settings-overlay");
    const inp = root.querySelector(".mf-settings-display-name");
    if (!overlay || !inp) return;
    if (!overlay.classList.contains("mf-hidden")) return;
    await refreshCloudUser(true);
    const raw = (await loadAuthorOverride()).trim();
    const email = state.cloudUser?.email?.trim() || "";
    inp.value = raw || email;
    inp.placeholder = email || "Display name";
    resetSettingsAvatarFormState();
    const cornerSel = root.querySelector(".mf-settings-panel-corner");
    if (cornerSel) cornerSel.value = await loadPanelCorner();
    const autoPauseCb = root.querySelector(".mf-settings-auto-pause-comments");
    if (autoPauseCb) {
      const { [STORAGE_KEYS.autoPauseCommentTyping]: ap } = await chrome.storage.local.get(
        STORAGE_KEYS.autoPauseCommentTyping
      );
      autoPauseCb.checked = normalizeAutoPauseCommentTyping(ap);
    }
    const urlInp = root.querySelector(".mf-settings-avatar-url");
    if (urlInp) urlInp.value = "";
    const storedAvatar = await loadStoredAvatar();
    if (urlInp && storedAvatar.startsWith("https://")) urlInp.value = storedAvatar;
    const previewLabel = inp.value.trim() || email || "You";
    applySettingsAvatarPreview(storedAvatar || null, previewLabel);
    overlay.classList.remove("mf-hidden");
    overlay.setAttribute("aria-hidden", "false");
    root.classList.add("mf-settings-open");
    settingsEscapeHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSettingsPanel();
      }
    };
    document.addEventListener("keydown", settingsEscapeHandler, true);
    requestAnimationFrame(() => inp.focus());
  }

  function closeSettingsPanel() {
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
  }

  async function saveSettingsPanel() {
    if (!root) return;
    const inp = root.querySelector(".mf-settings-display-name");
    if (!inp) return;
    await refreshCloudUser(false);
    const v = inp.value.trim();
    const email = state.cloudUser?.email?.trim() || "";
    let override = v;
    if (!v || (email && v === email)) override = "";
    await saveAuthorOverride(override);

    if (settingsAvatarExplicitClear) {
      await chrome.storage.local.set({ [STORAGE_KEYS.avatar]: "" });
    } else if (settingsAvatarPendingDataUrl) {
      await chrome.storage.local.set({ [STORAGE_KEYS.avatar]: settingsAvatarPendingDataUrl });
    } else {
      const urlInp = root.querySelector(".mf-settings-avatar-url");
      const u = (urlInp && urlInp.value.trim()) || "";
      if (u.startsWith("https://")) {
        await chrome.storage.local.set({ [STORAGE_KEYS.avatar]: u });
      }
    }

    const cornerSel = root.querySelector(".mf-settings-panel-corner");
    if (cornerSel) {
      const c = normalizePanelCorner(cornerSel.value);
      await chrome.storage.local.set({ [STORAGE_KEYS.panelCorner]: c });
      applyPanelCorner(c);
    }

    const autoPauseCb = root.querySelector(".mf-settings-auto-pause-comments");
    if (autoPauseCb) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.autoPauseCommentTyping]: !!autoPauseCb.checked,
      });
      applyAutoPauseCommentTypingPref(autoPauseCb.checked);
    }

    await refreshAuthorPresentationCache();
    if (root.dataset.mfView === "watch") renderThread();
    showToast("Settings saved.");
    closeSettingsPanel();
  }

  async function loadSidebarVisible() {
    const { [STORAGE_KEYS.sidebarVisible]: v } = await chrome.storage.local.get(
      STORAGE_KEYS.sidebarVisible
    );
    return v !== false;
  }

  /** @param {unknown} c */
  function normalizePanelCorner(c) {
    return c === "tl" || c === "tr" || c === "bl" || c === "br" ? c : "tr";
  }

  async function loadPanelCorner() {
    const { [STORAGE_KEYS.panelCorner]: c } = await chrome.storage.local.get(
      STORAGE_KEYS.panelCorner
    );
    return normalizePanelCorner(c);
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

  function getVideoElementForCommentPause() {
    const clip = resolveClipContext();
    if (clip) {
      const el = clip.getVideoElement();
      if (el && el.isConnected) return el;
    }
    return videoEl && videoEl.isConnected ? videoEl : null;
  }

  async function applySidebarLayoutFromStorage() {
    const got = await chrome.storage.local.get([
      STORAGE_KEYS.sidebarVisible,
      STORAGE_KEYS.panelCorner,
      STORAGE_KEYS.autoPauseCommentTyping,
    ]);
    applySidebarVisibility(got[STORAGE_KEYS.sidebarVisible] !== false);
    applyPanelCorner(got[STORAGE_KEYS.panelCorner]);
    applyAutoPauseCommentTypingPref(got[STORAGE_KEYS.autoPauseCommentTyping]);
  }

  async function setSidebarVisible(visible) {
    await chrome.storage.local.set({ [STORAGE_KEYS.sidebarVisible]: !!visible });
    applySidebarVisibility(visible);
  }

  /** Refetch review from Supabase and re-render watch UI (panel shown / expanded). */
  async function refreshWatchClipFromSupabase() {
    if (!root || root.dataset.mfView !== "watch" || root.dataset.mfLocked === "1") return;
    await refreshCloudUser(false);
    if (!(await getSupabaseConfigured()) || !isCloudActive()) return;
    const clip = resolveClipContext();
    if (!clip) return;
    await loadClipData(clip);
    await mergeClipMetadata(clip);
    await refreshWatchVideoTitle(clip);
    await updateWatchHeaderSub(clip);
    renderThread();
  }

  function applySidebarVisibility(visible) {
    const prevHidden = root ? root.classList.contains("mf-hidden") : true;
    if (root) root.classList.toggle("mf-hidden", !visible);
    if (!FEATURE_DRAWING) {
      if (canvasHost) canvasHost.style.visibility = "hidden";
    } else if (canvasHost && !state.drawMode) {
      canvasHost.style.visibility = visible ? "visible" : "hidden";
    }
    if (visible && prevHidden) {
      void refreshWatchClipFromSupabase();
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
      const av = normalizeCommentAvatarUrl(c.avatarUrl);
      if (av) c.avatarUrl = av;
      else delete c.avatarUrl;
    }
  }

  function normalizeCommentsShape() {
    normalizeCommentListShape(state.comments);
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
    await chrome.storage.local.set({ [key]: payload });
    if (clip.platform === "youtube") {
      await chrome.storage.local.remove(legacyYoutubeKey(clip.clipId));
    }
    notchLog("loadClipData mirrored cloud row to chrome.storage.local", {
      key,
      commentCount: payload.comments.length,
    });
  }

  async function loadClipData(clip) {
    state.replyTargetId = null;
    state.collapsedReplyRoots.clear();
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
            return;
          }
          await removeLocalClipCacheKeys(clip);
          await clearCollabHostForClip(clip);
          state.comments = [];
          normalizeCommentsShape();
          notchLog("loadClipData cloud: no row — cleared local cache, empty comments", {
            key,
            sharedReviewTarget,
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
        normalizeCommentsShape();
        await mirrorCloudRecordToLocalCache(clip, r.record);
        sharedReviewCloudReloadOnce.delete(key);
        notchLog("loadClipData applied from cloud", { commentCount: state.comments.length });
        return;
      }
      state.comments = [];
      normalizeCommentsShape();
      showToast("Could not load notes from the cloud. Check your connection and try again.");
      notchLog("loadClipData cloud fetch failed — not using local clip cache");
      return;
    }

    if (configured && !isCloudActive()) {
      state.comments = [];
      normalizeCommentsShape();
      notchLog("loadClipData: Supabase configured but not signed in — skip local clip cache");
      return;
    }

    let { [key]: raw } = await chrome.storage.local.get(key);
    if (!raw && clip.platform === "youtube") {
      const leg = legacyYoutubeKey(clip.clipId);
      const got = await chrome.storage.local.get(leg);
      raw = got[leg];
      if (raw && coerceIncomingComments(raw)) {
        await chrome.storage.local.set({ [key]: raw });
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
      normalizeCommentsShape();
    } else {
      state.comments = [];
    }
    notchLog("loadClipData end (local)", { commentCount: state.comments.length });
  }

  /**
   * Persist clip review: Supabase first when the project is configured and the user is signed in;
   * only then mirror to chrome.storage.local (write-through cache). Returns false if cloud save was required but failed.
   * @param {{ comments?: unknown[] }} [options] If `comments` is set, uses it instead of `state.comments` (no optimistic UI).
   */
  async function saveClipData(clip, options) {
    const commentsPayload = options?.comments != null ? options.comments : state.comments;
    if (!Array.isArray(commentsPayload)) {
      notchLog("saveClipData abort: comments not an array");
      return false;
    }

    const key = clip.storageKey;
    const { [key]: prev } = await chrome.storage.local.get(key);
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
        notchLog("saveClipData cloud result", {
          ok: r?.ok === true,
          typeofR: r == null ? "null" : typeof r,
          error: errCode || null,
          sharedReview,
          hostUserId: cloudHostForSave || null,
          platform: clip.platform,
          canonicalClipId,
        });
        if (!r?.ok) {
          showToast(cloudSaveFailureToast(errCode, sharedReview));
          return false;
        }
      } catch (e) {
        console.error("Notch cloud save", e);
        notchLog("saveClipData cloud exception", String(e?.message || e));
        showToast("Could not save to cloud — check your connection.");
        return false;
      }
      await chrome.storage.local.set({ [key]: payload });
      notchLog("saveClipData mirrored to chrome.storage.local after cloud ok", {
        key,
        commentCount: payload.comments.length,
      });
      return true;
    }

    if (configured && !isCloudActive()) {
      showToast("Sign in to save notes to the cloud.");
      return false;
    }

    await chrome.storage.local.set({ [key]: payload });
    notchLog("saveClipData local-only (no Supabase project)", {
      key,
      commentCount: payload.comments.length,
    });
    return true;
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
      const got = await chrome.storage.local.get(key);
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
        console.error("Notch cloud merge", e);
        showToast("Could not update video details in the cloud.");
        return;
      }
    }

    await chrome.storage.local.set({ [key]: next });
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

  async function listVideosWithFeedback() {
    await refreshCloudUser(false);
    if (await getSupabaseConfigured()) {
      const r = await sendExtensionMessage({ type: "MF_CLOUD_LIST_CLIPS" });
      if (r?.ok && Array.isArray(r.items)) {
        const out = r.items;
        for (const row of out) {
        if (row.thumbnailUrl) continue;
        if (row.platform === "vimeo") {
          const o = await fetchVimeoThumbFromBackground(row.clipId);
          if (!o) continue;
          row.thumbnailUrl = o;
          try {
            await sendExtensionMessage({
              type: "MF_CLOUD_UPDATE_THUMB",
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
            await sendExtensionMessage({
              type: "MF_CLOUD_UPDATE_THUMB",
              platform: row.platform,
              clipId: row.clipId,
              thumbnailUrl: o,
            });
          } catch {
            /* ignore */
          }
        } else if (row.platform === "googledrive") {
          const cur = resolveClipContext();
          if (cur && cur.platform === "googledrive" && cur.clipId === row.clipId) {
            const o = await fetchGoogleDriveThumbnailDataUrl(row.clipId);
            if (!o) continue;
            row.thumbnailUrl = o;
            try {
              await sendExtensionMessage({
                type: "MF_CLOUD_UPDATE_THUMB",
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
        return out;
      }
    }

    const all = await chrome.storage.local.get(null);
    const out = [];
    for (const [k, v] of Object.entries(all)) {
      if (!v || !Array.isArray(v.comments) || v.comments.length === 0) continue;

      let platform = null;
      let clipId = null;
      const parsed = parseClipStorageKey(k);
      if (parsed) {
        platform = parsed.platform;
        clipId = parsed.clipId;
      } else if (k.startsWith(STORAGE_KEYS.dataPrefix)) {
        platform = "youtube";
        clipId = k.slice(STORAGE_KEYS.dataPrefix.length);
      } else {
        continue;
      }

      if (!clipId) continue;
      if (!CLIP_PLATFORMS.includes(platform)) continue;

      let thumb = v.thumbnailUrl || null;
      if (platform === "youtube") {
        const thumbVid = thumb ? videoIdFromYtimgUrl(thumb) : null;
        if (thumbVid && thumbVid !== clipId) thumb = null;
      }

      let openUrl = "";
      if (platform === "youtube") {
        openUrl = "https://www.youtube.com/watch?v=" + encodeURIComponent(clipId);
      } else if (platform === "vimeo") {
        openUrl = "https://vimeo.com/" + encodeURIComponent(clipId);
      } else if (platform === "loom") {
        openUrl = "https://www.loom.com/share/" + encodeURIComponent(clipId);
      } else if (platform === "googledrive") {
        openUrl = "https://drive.google.com/file/d/" + encodeURIComponent(clipId) + "/view";
      } else if (platform === "dropbox") {
        openUrl = buildDropboxOpenUrl(clipId);
      } else {
        openUrl = "";
      }

      out.push({
        storageKey: k,
        platform,
        clipId,
        title: clipDisplayTitleFromStorage(v, platform),
        thumbnailUrl: thumb || defaultThumbForPlatform(platform, clipId) || "",
        commentCount: v.comments.length,
        updatedAt: v.updatedAt || 0,
        openUrl,
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const row of out) {
      if (row.thumbnailUrl) continue;
      if (row.platform === "vimeo") {
        const o = await fetchVimeoThumbFromBackground(row.clipId);
        if (!o) continue;
        row.thumbnailUrl = o;
        const sk = row.storageKey;
        const got = await chrome.storage.local.get(sk);
        const rec = got[sk];
        if (rec && !rec.thumbnailUrl) {
          await chrome.storage.local.set({ [sk]: { ...rec, thumbnailUrl: o } });
          row.title = clipDisplayTitleFromStorage({ ...rec, thumbnailUrl: o }, row.platform);
        }
      } else if (row.platform === "loom") {
        const o = await fetchLoomThumbFromBackground(row.clipId);
        if (!o) continue;
        row.thumbnailUrl = o;
        const sk = row.storageKey;
        const got = await chrome.storage.local.get(sk);
        const rec = got[sk];
        if (rec && !rec.thumbnailUrl) {
          await chrome.storage.local.set({ [sk]: { ...rec, thumbnailUrl: o } });
          row.title = clipDisplayTitleFromStorage({ ...rec, thumbnailUrl: o }, row.platform);
        }
      } else if (row.platform === "googledrive") {
        const cur = resolveClipContext();
        if (cur && cur.platform === "googledrive" && cur.clipId === row.clipId) {
          const o = await fetchGoogleDriveThumbnailDataUrl(row.clipId);
          if (!o) continue;
          row.thumbnailUrl = o;
          const sk = row.storageKey;
          const got = await chrome.storage.local.get(sk);
          const rec = got[sk];
          if (rec && !rec.thumbnailUrl) {
            await chrome.storage.local.set({ [sk]: { ...rec, thumbnailUrl: o } });
            row.title = clipDisplayTitleFromStorage({ ...rec, thumbnailUrl: o }, row.platform);
          }
        }
      }
    }
    return out;
  }

  /** All storage keys that hold the same clip (YouTube has new + legacy keys; deleting one must remove both or migration restores data). */
  function storageKeysForDashboardItem(item) {
    if (!item || !item.storageKey) return [];
    const keys = new Set([item.storageKey]);
    if (item.platform === "youtube" && item.clipId) {
      keys.add(clipStorageKey("youtube", item.clipId));
      keys.add(legacyYoutubeKey(item.clipId));
    }
    return [...keys];
  }

  async function removeClipFromLibrary(item) {
    if (!item || !item.storageKey) return;
    await refreshCloudUser(false);
    const keys = storageKeysForDashboardItem(item);
    if (await getSupabaseConfigured()) {
      try {
        const r = await sendExtensionMessage({
          type: "MF_CLOUD_DELETE_CLIP",
          platform: item.platform,
          clipId: item.clipId,
        });
        if (!r?.ok) throw new Error("cloud delete failed");
      } catch (e) {
        console.error("Notch cloud delete", e);
        throw e;
      }
    }
    // Write-through: drop mirrored `markframe_clip_<platform>_<clipId>` keys only after cloud delete succeeds (or when cloud is not configured).
    await chrome.storage.local.remove(keys);

    const cur = resolveClipContext();
    const isCurrentPageClip =
      cur && cur.platform === item.platform && cur.clipId === item.clipId;
    const hadThisKeyLoaded =
      activeClipStorageKey != null && keys.includes(activeClipStorageKey);

    if (isCurrentPageClip || hadThisKeyLoaded) {
      activeClipStorageKey = null;
      state.comments = [];
      state.selectedId = null;
      state.replyTargetId = null;
      state.collapsedReplyRoots.clear();
      teardownCanvas();
      if (root && root.dataset.mfView === "watch") {
        renderThread();
      }
    }
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

  function uid() {
    return "mf_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function createCommentAvatarEl(comment) {
    const holder = document.createElement("div");
    holder.className = "mf-comment-avatar";
    const authorName = comment?.author;
    const label = authorName || "You";
    const commentAvatar = normalizeCommentAvatarUrl(comment?.avatarUrl);
    const ownAvatar =
      cachedAuthorAvatarUrl && label === cachedEffectiveDisplayName ? cachedAuthorAvatarUrl : "";
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
    };
    if (threadParentId) {
      c.parentId = threadParentId;
    } else {
      c.complete = false;
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

  function createCommentElement(c, isReply) {
    const el = document.createElement("div");
    el.className = "mf-comment" + (isReply ? " mf-reply" : "");
    if (state.selectedId === c.id) el.classList.add("mf-selected");
    if (!isReply && !c.complete) el.classList.add("mf-incomplete");
    el.addEventListener("click", (e) => {
      if (e.target.closest("button.mf-status-btn")) return;
      if (e.target.closest(".mf-comment-actions")) return;
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
    auth.textContent = c.author || "You";
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
      el.appendChild(actions);
    }

    return el;
  }

  function updateCopyReviewLinkButtonState() {
    if (!root) return;
    const copyBtn = root.querySelector('[data-action="copy-link"]');
    if (!copyBtn) return;
    const hasComments = Array.isArray(state.comments) && state.comments.length > 0;
    copyBtn.disabled = !hasComments;
    copyBtn.title = hasComments ? "Copy review link" : "Needs at least 1 comment first";
  }

  function renderThread() {
    if (!root) return;
    updateCopyReviewLinkButtonState();
    const thread = root.querySelector(".mf-thread");
    if (!thread) return;
    thread.innerHTML = "";
    const roots = state.comments
      .filter((c) => !c.parentId)
      .sort((a, b) => a.ts - b.ts);
    if (!roots.length) {
      const empty = document.createElement("div");
      empty.className = "mf-empty";
      empty.textContent = "No comments yet.";
      thread.appendChild(empty);
      return;
    }

    for (const rootComment of roots) {
      const block = document.createElement("div");
      block.className = "mf-comment-block";
      const rootEl = createCommentElement(rootComment, false);
      const reps = repliesSortedForRoot(rootComment.id);
      const replyCount = reps.length;
      const threadCollapsed =
        replyCount > 0 && state.collapsedReplyRoots.has(rootComment.id);
      if (replyCount) {
        const actions = rootEl.querySelector(".mf-comment-actions");
        if (actions) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "mf-comment-replies-toggle";
          toggle.textContent = threadCollapsed
            ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
            : "Hide replies";
          toggle.title = threadCollapsed ? "Show replies" : "Hide replies";
          toggle.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.collapsedReplyRoots.has(rootComment.id)) {
              state.collapsedReplyRoots.delete(rootComment.id);
            } else {
              state.collapsedReplyRoots.add(rootComment.id);
            }
            renderThread();
          });
          actions.appendChild(toggle);
        }
      }
      block.appendChild(rootEl);
      if (replyCount && !threadCollapsed) {
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
    wrap.innerHTML = `
      <div class="mf-gate-pane">
        <div class="mf-gate-brand">Notch</div>
        <p class="mf-gate-title"></p>
        <p class="mf-gate-msg"></p>
        <div class="mf-gate-form mf-hidden">
          <div class="mf-gate-tabs" role="tablist" aria-label="Account">
            <button
              type="button"
              id="mf-gate-tab-sign-in"
              class="mf-gate-tab mf-gate-tab-active"
              data-gate-tab="sign-in"
              role="tab"
              aria-selected="true"
              aria-controls="mf-gate-fields"
            >
              Log in
            </button>
            <button
              type="button"
              id="mf-gate-tab-sign-up"
              class="mf-gate-tab"
              data-gate-tab="sign-up"
              role="tab"
              aria-selected="false"
              aria-controls="mf-gate-fields"
            >
              Sign up
            </button>
          </div>
          <div id="mf-gate-fields" class="mf-gate-fields" role="tabpanel">
            <label class="mf-gate-label"
              >Email
              <input
                type="email"
                class="mf-gate-input mf-gate-email"
                autocomplete="username"
                maxlength="320"
              />
            </label>
            <label class="mf-gate-label"
              >Password
              <input
                type="password"
                class="mf-gate-input mf-gate-password"
                autocomplete="current-password"
                maxlength="200"
              />
            </label>
            <div class="mf-gate-signup-only mf-hidden">
              <label class="mf-gate-label"
                >Confirm password
                <input
                  type="password"
                  class="mf-gate-input mf-gate-password-confirm"
                  autocomplete="new-password"
                  maxlength="200"
                />
              </label>
            </div>
          </div>
          <p class="mf-gate-status" aria-live="polite"></p>
          <div class="mf-gate-actions">
            <button type="button" class="mf-btn mf-btn-primary mf-gate-btn-signin" data-action="gate-sign-in">
              Sign in
            </button>
            <button type="button" class="mf-btn mf-btn-primary mf-gate-btn-signup mf-hidden" data-action="gate-sign-up">
              Create account
            </button>
          </div>
        </div>
      </div>
      <div class="mf-app-shell mf-hidden">
        <div class="mf-header">
          <div class="mf-header-text">
            <div class="mf-brand">Notch</div>
            <div class="mf-header-sub"></div>
            <p class="mf-header-sync-msg" aria-live="polite"></p>
          </div>
          <div class="mf-header-actions">
            <button type="button" class="mf-back-dashboard" data-action="go-dashboard" title="All reviewed videos">
              ← All reviews
            </button>
            <button type="button" class="mf-back-watch" data-action="go-watch-panel" title="Notes for this video">
              This video
            </button>
            <button type="button" class="mf-settings-btn" data-action="open-settings" title="Settings" aria-label="Settings">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button type="button" class="mf-collapse" data-action="collapse" title="Collapse">▾</button>
          </div>
        </div>
        <div class="mf-watch-pane">
          <div class="mf-watch-video-title-wrap">
            <span class="mf-watch-video-title" role="status" aria-live="polite"></span>
          </div>
          <div class="mf-toolbar">
            <div class="mf-toolbar-draw${FEATURE_DRAWING ? "" : " mf-hidden"}">
              <button type="button" class="mf-btn" data-action="toggle-draw">Draw</button>
              <input type="color" class="mf-color" data-action="color" value="#00E5FF" aria-label="Stroke color" />
              <button type="button" class="mf-btn mf-btn-primary" data-action="save-draw">Save drawing</button>
            </div>
            <button type="button" class="mf-btn" data-action="copy-link">Copy review link</button>
            <button type="button" class="mf-btn mf-export-pdf-btn" data-action="export-pdf" title="Export PDF" aria-label="Export PDF">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-file-down" aria-hidden="true">
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                <path d="M12 18v-6" />
                <path d="m9 15 3 3 3-3" />
                <path d="M4 12V4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2" />
              </svg>
            </button>
            <div class="mf-screengrab-wrap">
              <button
                type="button"
                class="mf-btn mf-screengrab-hover-label"
                title="Screengrab — hover for download or copy"
                aria-label="Screengrab"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-camera" aria-hidden="true">
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
              </button>
              <div class="mf-screengrab-flyout" role="group" aria-label="Screengrab options">
                <button
                  type="button"
                  class="mf-btn mf-screengrab-flyout-btn"
                  data-action="screengrab-download"
                  title="Download PNG"
                  aria-label="Download PNG"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-download" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" x2="12" y1="15" y2="3" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="mf-btn mf-screengrab-flyout-btn"
                  data-action="screengrab-copy"
                  title="Copy image to clipboard"
                  aria-label="Copy image to clipboard"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-clipboard" aria-hidden="true">
                    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
                    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <div class="mf-thread"></div>
          <div class="mf-footer">
            <div class="mf-input-row">
              <input type="text" class="mf-comment-input" placeholder="Comment at current time…" maxlength="2000" />
            </div>
          </div>
        </div>
        <div class="mf-dashboard-pane mf-hidden">
          <div class="mf-offyoutube-banner mf-hidden" role="status"></div>
          <div class="mf-dashboard-list"></div>
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
            <label class="mf-settings-label"
              >Display name
              <input
                type="text"
                class="mf-settings-display-name"
                maxlength="80"
                autocomplete="nickname"
                spellcheck="false"
              />
            </label>
            <div class="mf-settings-sign-out-row mf-hidden">
              <button type="button" class="mf-btn" data-action="sign-out">Sign out</button>
            </div>
            <label class="mf-settings-label mf-settings-label-tight"
              >Panel corner
              <select class="mf-settings-panel-corner" aria-label="Panel corner">
                <option value="tr">Top right</option>
                <option value="tl">Top left</option>
                <option value="br">Bottom right</option>
                <option value="bl">Bottom left</option>
              </select>
            </label>
            <label class="mf-settings-toggle-row">
              <input type="checkbox" class="mf-settings-auto-pause-comments" />
              <span class="mf-settings-toggle-text">Auto pause when typing comments</span>
            </label>
            <div class="mf-settings-avatar-section">
              <span class="mf-settings-section-title">Avatar</span>
              <div class="mf-settings-avatar-row">
                <div class="mf-settings-avatar-preview-wrap">
                  <img class="mf-settings-avatar-preview mf-hidden" alt="" width="40" height="40" />
                  <span class="mf-settings-avatar-preview-fallback" aria-hidden="true"></span>
                </div>
                <div class="mf-settings-avatar-buttons">
                  <input type="file" class="mf-settings-avatar-file" accept="image/*" tabindex="-1" />
                  <button type="button" class="mf-btn" data-action="pick-avatar">Choose image…</button>
                  <button type="button" class="mf-btn" data-action="clear-avatar">Remove</button>
                </div>
              </div>
              <label class="mf-settings-label mf-settings-label-tight"
                >Or image URL (https)
                <input
                  type="url"
                  class="mf-settings-avatar-url"
                  maxlength="2000"
                  placeholder="https://…"
                  spellcheck="false"
                />
              </label>
            </div>
            <div class="mf-settings-actions">
              <button type="button" class="mf-btn mf-btn-primary" data-action="save-settings">Save</button>
            </div>
          </div>
        </div>
      </div>
      <div class="mf-toast" aria-live="polite"></div>
    `;
    return wrap;
  }

  function setView(mode) {
    if (!root) return;
    root.dataset.mfView = mode;
    const cur = resolveClipContext();
    root.dataset.mfOnWatch = mode === "dashboard" && cur ? "1" : "";
    const watchPane = root.querySelector(".mf-watch-pane");
    const dashPane = root.querySelector(".mf-dashboard-pane");
    const sub = root.querySelector(".mf-header-sub");
    if (watchPane) watchPane.classList.toggle("mf-hidden", mode !== "watch");
    if (dashPane) dashPane.classList.toggle("mf-hidden", mode !== "dashboard");
    if (sub) {
      sub.textContent = "";
    }
    void updateSyncBar();
  }

  function updateOffClipBanner() {
    if (!root) return;
    const ban = root.querySelector(".mf-offyoutube-banner");
    if (!ban) return;
    const cur = resolveClipContext();
    const off = !cur;
    ban.classList.toggle("mf-hidden", !off);
    root.dataset.mfOffYoutube = off ? "1" : "";
    if (off) {
      ban.textContent =
        "No supported video on this page. Open YouTube, Vimeo, Loom, a Google Drive file, or a Dropbox preview—or pick a saved review below.";
    }
  }

  function appendDashboardRow(listEl, item, sharedWithMe) {
    const row = document.createElement("div");
    row.className = "mf-dash-row";

    const card = document.createElement("button");
    card.type = "button";
    card.className = "mf-dash-card";
    card.title = item.title;
    const thumb = document.createElement("img");
    thumb.className = "mf-dash-thumb";
    thumb.src = item.thumbnailUrl;
    thumb.alt = "";
    thumb.loading = "lazy";
    const meta = document.createElement("span");
    meta.className = "mf-dash-meta";
    const badge = document.createElement("span");
    badge.className = "mf-dash-platform";
    badge.textContent = item.platform;
    const t = document.createElement("span");
    t.className = "mf-dash-title";
    t.textContent = item.title;
    const c = document.createElement("span");
    c.className = "mf-dash-count";
    c.textContent = item.commentCount + " note" + (item.commentCount === 1 ? "" : "s");
    meta.appendChild(badge);
    meta.appendChild(t);
    meta.appendChild(c);
    card.appendChild(thumb);
    card.appendChild(meta);
    card.addEventListener("click", () => {
      state.dashboardForced = false;
      const cur = resolveClipContext();
      let sameClip = cur && cur.platform === item.platform && cur.clipId === item.clipId;
      if (
        !sameClip &&
        item.platform === "dropbox" &&
        isDropboxSite()
      ) {
        const dropId = parseDropboxClipId();
        if (dropId && dropboxClipIdsEquivalent(item.clipId, dropId)) {
          sameClip = true;
        }
      }
      if (sameClip) {
        setDrawModeUi(false);
        void tick();
        return;
      }
      if (item.openUrl) {
        location.href = item.openUrl;
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "mf-dash-delete";
    if (sharedWithMe) {
      const hostId = item.reviewOwnerUserId && String(item.reviewOwnerUserId).trim();
      delBtn.classList.add("mf-dash-delete--icon");
      delBtn.setAttribute("aria-label", "Remove yourself as collaborator — host keeps all notes");
      delBtn.title = "Remove yourself as collaborator";
      delBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mf-lucide mf-lucide-log-out" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>';
      delBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!hostId) return;
        if (
          !confirm(
            "Remove yourself as a collaborator on this review? The host keeps every note; you will no longer see this in Shared with me."
          )
        ) {
          return;
        }
        const ok = await removeSelfAsCollaborator(item.platform, item.clipId, hostId);
        if (ok) {
          lastTickSignature = "";
          showToast("You are no longer a collaborator.");
          await renderDashboard();
          void tick();
        } else {
          console.error("Notch: collab leave failed");
          showToast("Could not update — try again.");
        }
      });
    } else {
      delBtn.setAttribute("aria-label", "Delete saved notes for this video");
      delBtn.title = "Delete from library";
      delBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (
          !confirm(
            "Remove all notes and drawings saved for this video? This cannot be undone."
          )
        ) {
          return;
        }
        try {
          await removeClipFromLibrary(item);
          showToast("Removed from library.");
          await renderDashboard();
        } catch (err) {
          console.error("Notch: delete failed", err);
          showToast("Could not remove — try again.");
        }
      });
      delBtn.textContent = "×";
    }

    row.appendChild(card);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  }

  function partitionDashboardItems(items) {
    const mine = [];
    const shared = [];
    const myId = state.cloudUser?.id && String(state.cloudUser.id).trim();
    for (const item of items) {
      const owner = item.reviewOwnerUserId;
      if (
        !owner ||
        !myId ||
        normalizeUuidForCompare(owner) === normalizeUuidForCompare(myId)
      ) {
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

  async function renderDashboard() {
    if (!root) return;
    const gen = ++dashboardRenderGeneration;
    await refreshCloudUser(false);
    await updateSyncBar();
    updateOffClipBanner();
    const listEl = root.querySelector(".mf-dashboard-list");
    if (!listEl) return;
    const items = await listVideosWithFeedback();
    if (gen !== dashboardRenderGeneration) return;
    listEl.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mf-dashboard-empty";
      empty.textContent =
        "No reviews yet. Open a YouTube, Vimeo, Loom, Google Drive, or Dropbox video and add a note.";
      listEl.appendChild(empty);
      return;
    }
    const { mine, shared } = partitionDashboardItems(items);
    function appendSection(title, sectionItems, sectionShared) {
      if (sectionItems.length === 0) return;
      const h = document.createElement("div");
      h.className = "mf-dashboard-section-title";
      h.textContent = title;
      listEl.appendChild(h);
      for (const item of sectionItems) appendDashboardRow(listEl, item, sectionShared);
    }
    appendSection("My reviews", mine, false);
    appendSection("Shared with me", shared, true);
  }

  function wireScreengrabFlyoutPortal(root) {
    const wrap = root.querySelector(".mf-screengrab-wrap");
    const trigger = root.querySelector(".mf-screengrab-hover-label");
    const flyout = root.querySelector(".mf-screengrab-flyout");
    if (!wrap || !trigger || !flyout) return;

    document.body.appendChild(flyout);
    flyout.classList.add("mf-screengrab-flyout--portaled");

    let hideTimer = null;
    const gapPx = 6;
    const hideDelayMs = 140;

    function positionFlyout() {
      const r = trigger.getBoundingClientRect();
      const top = Math.round(r.bottom + gapPx);
      const left = Math.round(r.left);
      const minW = Math.round(r.width);
      flyout.style.top = `${top}px`;
      flyout.style.left = `${left}px`;
      flyout.style.minWidth = `${minW}px`;
      requestAnimationFrame(() => {
        const fr = flyout.getBoundingClientRect();
        const vw = window.innerWidth;
        const pad = 8;
        let adjLeft = left;
        if (fr.right > vw - pad) adjLeft = Math.max(pad, Math.round(vw - fr.width - pad));
        if (adjLeft < pad) adjLeft = pad;
        if (adjLeft !== left) flyout.style.left = `${adjLeft}px`;
      });
    }

    function openFlyout() {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      flyout.classList.add("mf-screengrab-flyout-open");
      positionFlyout();
    }

    function closeFlyout() {
      flyout.classList.remove("mf-screengrab-flyout-open");
    }

    function scheduleClose() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        closeFlyout();
        hideTimer = null;
      }, hideDelayMs);
    }

    wrap.addEventListener("mouseenter", openFlyout);
    flyout.addEventListener("mouseenter", () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    });
    wrap.addEventListener("mouseleave", scheduleClose);
    flyout.addEventListener("mouseleave", scheduleClose);

    function onScrollOrResize() {
      if (!flyout.classList.contains("mf-screengrab-flyout-open")) return;
      positionFlyout();
    }
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
  }

  function wireSidebar() {
    root.querySelector('[data-action="go-dashboard"]').addEventListener("click", async () => {
      state.dashboardForced = true;
      setDrawModeUi(false);
      void tick();
    });

    root.querySelector('[data-action="go-watch-panel"]').addEventListener("click", () => {
      state.dashboardForced = false;
      setDrawModeUi(false);
      void tick();
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

    root.querySelector('[data-action="open-settings"]').addEventListener("click", () => void openSettingsPanel());
    root.querySelectorAll('[data-action="close-settings"]').forEach((b) => {
      b.addEventListener("click", () => closeSettingsPanel());
    });
    const saveSettingsBtn = root.querySelector('[data-action="save-settings"]');
    if (saveSettingsBtn) {
      saveSettingsBtn.addEventListener("click", () => void saveSettingsPanel());
    }
    const settingsOverlay = root.querySelector(".mf-settings-overlay");
    if (settingsOverlay) {
      settingsOverlay.addEventListener("click", (e) => {
        if (e.target === settingsOverlay) closeSettingsPanel();
      });
    }
    const settingsNameInp = root.querySelector(".mf-settings-display-name");
    if (settingsNameInp) {
      settingsNameInp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void saveSettingsPanel();
        }
      });
    }

    const pickAvatarBtn = root.querySelector('[data-action="pick-avatar"]');
    const avatarFileInp = root.querySelector(".mf-settings-avatar-file");
    const clearAvatarBtn = root.querySelector('[data-action="clear-avatar"]');
    if (pickAvatarBtn && avatarFileInp) {
      pickAvatarBtn.addEventListener("click", () => avatarFileInp.click());
      avatarFileInp.addEventListener("change", () => {
        const f = avatarFileInp.files && avatarFileInp.files[0];
        if (!f) return;
        compressAvatarFile(f)
          .then((dataUrl) => {
            settingsAvatarPendingDataUrl = dataUrl;
            settingsAvatarExplicitClear = false;
            const nameInp = root.querySelector(".mf-settings-display-name");
            const email = state.cloudUser?.email?.trim() || "";
            const previewLabel = (nameInp && nameInp.value.trim()) || email || "You";
            applySettingsAvatarPreview(dataUrl, previewLabel);
            const urlInp = root.querySelector(".mf-settings-avatar-url");
            if (urlInp) urlInp.value = "";
          })
          .catch((err) => showToast(err.message || "Could not use that image."));
        avatarFileInp.value = "";
      });
    }
    if (clearAvatarBtn) {
      clearAvatarBtn.addEventListener("click", () => {
        settingsAvatarExplicitClear = true;
        settingsAvatarPendingDataUrl = null;
        const urlInp = root.querySelector(".mf-settings-avatar-url");
        if (urlInp) urlInp.value = "";
        const nameInp = root.querySelector(".mf-settings-display-name");
        const email = state.cloudUser?.email?.trim() || "";
        const previewLabel = (nameInp && nameInp.value.trim()) || email || "You";
        applySettingsAvatarPreview(null, previewLabel);
      });
    }
    const avatarUrlInp = root.querySelector(".mf-settings-avatar-url");
    if (avatarUrlInp) {
      avatarUrlInp.addEventListener("input", () => {
        settingsAvatarExplicitClear = false;
        settingsAvatarPendingDataUrl = null;
        const u = avatarUrlInp.value.trim();
        const nameInp = root.querySelector(".mf-settings-display-name");
        const email = state.cloudUser?.email?.trim() || "";
        const previewLabel = (nameInp && nameInp.value.trim()) || email || "You";
        if (u.startsWith("https://")) {
          applySettingsAvatarPreview(u, previewLabel);
        } else if (!u) {
          void loadStoredAvatar().then((s) => {
            const nm = root.querySelector(".mf-settings-display-name");
            const em = state.cloudUser?.email?.trim() || "";
            const pl = (nm && nm.value.trim()) || em || "You";
            applySettingsAvatarPreview(s || null, pl);
          });
        } else {
          applySettingsAvatarPreview(null, previewLabel);
        }
      });
    }

    const gateForm = root.querySelector(".mf-gate-form");
    if (gateForm) {
      syncGateAuthTab("sign-in");
      root.querySelectorAll(".mf-gate-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.getAttribute("data-gate-tab") === "sign-up" ? "sign-up" : "sign-in";
          syncGateAuthTab(mode);
          setGateStatus("");
        });
      });
    }

    const gateSignIn = root.querySelector('[data-action="gate-sign-in"]');
    if (gateSignIn) {
      gateSignIn.addEventListener("click", () => void submitGateSignIn());
    }
    const gateSignUp = root.querySelector('[data-action="gate-sign-up"]');
    if (gateSignUp) {
      gateSignUp.addEventListener("click", () => void submitGateSignUp());
    }
    const gatePass = root.querySelector(".mf-gate-password");
    if (gatePass) {
      gatePass.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (gateAuthTabMode() === "sign-up") void submitGateSignUp();
          else void submitGateSignIn();
        }
      });
    }
    const gatePassConfirm = root.querySelector(".mf-gate-password-confirm");
    if (gatePassConfirm) {
      gatePassConfirm.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submitGateSignUp();
        }
      });
    }

    const signOutBtn = root.querySelector('[data-action="sign-out"]');
    if (signOutBtn) {
      signOutBtn.addEventListener("click", async () => {
        try {
          await clearAllCollabHostBindings();
          await sendExtensionMessage({ type: "MF_SUPABASE_SIGN_OUT" });
          cloudAuthCacheValidUntil = 0;
          lastTickSignature = "";
          await refreshCloudUser(true);
          showToast("Signed out.");
          void tick();
        } catch (e) {
          console.error("Notch: sign out", e);
          showToast("Sign out failed — try again.");
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
    root.querySelector('[data-action="export-pdf"]').addEventListener("click", () => {
      void generateCommentsPdf();
    });

    root.querySelector('[data-action="screengrab-download"]').addEventListener("click", () => {
      void downloadCurrentVideoFrame();
    });
    root.querySelector('[data-action="screengrab-copy"]').addEventListener("click", () => {
      void copyCurrentVideoFrameToClipboard();
    });
    wireScreengrabFlyoutPortal(root);

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
      console.error("Notch screengrab drawImage", e);
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
      console.error("Notch screengrab toDataURL", e);
      return null;
    }
  }

  /** For PDF: seek, wait for a decodable frame, return canvas (jsPDF addImage handles canvas reliably). */
  async function captureVideoFrameCanvasForPdf(clip, timeSec) {
    if (!clip) return null;
    const el = clip.getVideoElement();
    if (!el) return null;

    if (el instanceof HTMLVideoElement && el.isConnected) {
      try {
        await seekVideoAwaitSeeked(el, timeSec, 6000);
      } catch {
        return null;
      }
      const ok = await waitVideoHasDrawableFrame(el, 2500);
      if (!ok) return null;
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      let cap = videoFrameToCaptureCanvas(el);
      if (cap) return cap;
      if (clip.platform === "googledrive") {
        const pngUrl = await captureGoogleDriveVisibleTabPngDataUrl({ quiet: true });
        if (pngUrl) return await pngDataUrlToCaptureCanvas(pngUrl);
      }
      return null;
    }

    if (clip.platform === "googledrive") {
      try {
        el.currentTime = timeSec;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 900));
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      const pngUrl = await captureGoogleDriveVisibleTabPngDataUrl({ quiet: true });
      if (!pngUrl) return null;
      return await pngDataUrlToCaptureCanvas(pngUrl);
    }

    return null;
  }

  function naturalSizeFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => reject(new Error("image load"));
      im.src = dataUrl;
    });
  }

  async function pngDataUrlToCaptureCanvas(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") return null;
    try {
      const { w, h } = await naturalSizeFromDataUrl(dataUrl);
      if (!w || !h) return null;
      const im = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("img"));
        i.src = dataUrl;
      });
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      if (!g) return null;
      g.drawImage(im, 0, 0, w, h);
      return { canvas: c, w, h };
    } catch {
      return null;
    }
  }

  /** Match content.css —mf-bg / —mf-text / —mf-accent */
  const NOTCH_PDF_BG = [13, 13, 15];
  const NOTCH_PDF_ELEVATED = [20, 20, 24];
  const NOTCH_PDF_TEXT = [224, 224, 226];
  const NOTCH_PDF_MUTED = [128, 130, 138];
  const NOTCH_PDF_ACCENT = [0, 229, 255];

  function arrayBufferToBase64ForPdf(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /** Preserve aspect ratio inside maxW × maxH (fixes “squished” stills). */
  function pdfFitImageMm(nw, nh, maxW, maxH) {
    if (!nw || !nh || maxW <= 0 || maxH <= 0) return { w: maxW, h: maxH };
    const scale = Math.min(maxW / nw, maxH / nh);
    return { w: nw * scale, h: nh * scale };
  }

  function pdfFillNotchPageBackground(doc, pageW, pageH) {
    doc.setFillColor.apply(doc, NOTCH_PDF_BG);
    doc.rect(0, 0, pageW, pageH, "F");
  }

  /**
   * Notch UI uses Roboto (see content.css --mf-font); load from gstatic with Helvetica fallback.
   * Black = 900 weight for the wordmark (bolder than Bold).
   */
  async function registerNotchPdfRobotoFonts(doc) {
    const regularUrl = "https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxP.ttf";
    const boldUrl = "https://fonts.gstatic.com/s/roboto/v30/KFOlCnqEu92Fr1MmEU9fChc9.ttf";
    const blackUrl = "https://fonts.gstatic.com/s/roboto/v30/KFOlCnqEu92Fr1MmWUlfChc9.ttf";
    const out = { ok: false, black: false };
    try {
      const [reg, bol] = await Promise.all([fetch(regularUrl), fetch(boldUrl)]);
      if (!reg.ok || !bol.ok) return out;
      const [regBuf, bolBuf] = await Promise.all([reg.arrayBuffer(), bol.arrayBuffer()]);
      doc.addFileToVFS("Roboto-Regular.ttf", arrayBufferToBase64ForPdf(regBuf));
      doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
      doc.addFileToVFS("Roboto-Bold.ttf", arrayBufferToBase64ForPdf(bolBuf));
      doc.addFont("Roboto-Bold.ttf", "Roboto", "bold");
      out.ok = true;
      try {
        const bl = await fetch(blackUrl);
        if (bl.ok) {
          const blBuf = await bl.arrayBuffer();
          doc.addFileToVFS("Roboto-Black.ttf", arrayBufferToBase64ForPdf(blBuf));
          doc.addFont("Roboto-Black.ttf", "Roboto", "black");
          out.black = true;
        }
      } catch (_) {}
      return out;
    } catch (e) {
      console.warn("Notch PDF Roboto", e);
      return out;
    }
  }

  /** 720p landscape pages (matches 16:9 at 1280×720). */
  const PDF_PAGE_PX = { w: 1280, h: 720 };
  const PDF_COVER_GAP = {
    afterBrand: 72,
    subAfter: 36,
    ruleAfter: 92,
    titleAfter: 44,
    platAfter: 44,
    genAfter: 36,
  };
  /** Tuned for 720px-tall pages under the still. */
  const PDF_COMMENT_GAP = {
    head: 28,
    afterStill: 20,
    author: 16,
    line: 14,
    afterBody: 12,
  };

  function pdfTitleCoverBlockHeight(doc, face, brandStyle, titleLineCount, lineHTitle) {
    let h = 0;
    doc.setFont(face, brandStyle);
    doc.setFontSize(88);
    h += doc.internal.getLineHeight() / doc.internal.scaleFactor + PDF_COVER_GAP.afterBrand;
    doc.setFont(face, "normal");
    doc.setFontSize(22);
    h += doc.internal.getLineHeight() / doc.internal.scaleFactor + PDF_COVER_GAP.subAfter + PDF_COVER_GAP.ruleAfter;
    doc.setFont(face, "bold");
    doc.setFontSize(28);
    h += titleLineCount * lineHTitle + PDF_COVER_GAP.titleAfter;
    doc.setFont(face, "normal");
    doc.setFontSize(20);
    const lhMeta = doc.internal.getLineHeight() / doc.internal.scaleFactor;
    h += lhMeta + PDF_COVER_GAP.platAfter + lhMeta + PDF_COVER_GAP.genAfter + lhMeta;
    return h;
  }

  function canvasRoundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(Math.max(0, r), w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /**
   * Draw source into destW×destH with rounded corners (radiusFrac of min side). Renders at higher
   * internal res for smooth edges; embed as PNG so corners show in all PDF viewers (PDF clip is flaky).
   */
  function rasterToRoundedPngDataUrl(sourceCanvas, destW, destH, radiusFrac) {
    if (!sourceCanvas || !destW || !destH) return null;
    const r = Math.max(1, Math.min(destW, destH) * radiusFrac);
    const dpr = Math.min(2, Math.max(1, Math.floor(1400 / Math.max(destW, destH, 1))));
    const cw = Math.max(1, Math.round(destW * dpr));
    const ch = Math.max(1, Math.round(destH * dpr));
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d");
    if (!g) return null;
    g.clearRect(0, 0, cw, ch);
    g.save();
    try {
      g.scale(dpr, dpr);
      if (typeof g.roundRect === "function") {
        g.beginPath();
        g.roundRect(0, 0, destW, destH, r, r);
        g.clip();
      } else {
        canvasRoundRectPath(g, 0, 0, destW, destH, r);
        g.clip();
      }
      g.drawImage(sourceCanvas, 0, 0, destW, destH);
      return c.toDataURL("image/png");
    } catch (e) {
      console.error("Notch PDF rounded raster", e);
      return null;
    } finally {
      g.restore();
    }
  }

  async function dataUrlToRoundedPngDataUrl(dataUrl, destW, destH, radiusFrac) {
    const im = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("img"));
      i.src = dataUrl;
    });
    const r = Math.max(1, Math.min(destW, destH) * radiusFrac);
    const dpr = Math.min(2, Math.max(1, Math.floor(1200 / Math.max(destW, destH, 1))));
    const cw = Math.max(1, Math.round(destW * dpr));
    const ch = Math.max(1, Math.round(destH * dpr));
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d");
    if (!g) return null;
    g.clearRect(0, 0, cw, ch);
    g.save();
    try {
      g.scale(dpr, dpr);
      if (typeof g.roundRect === "function") {
        g.beginPath();
        g.roundRect(0, 0, destW, destH, r, r);
        g.clip();
      } else {
        canvasRoundRectPath(g, 0, 0, destW, destH, r);
        g.clip();
      }
      g.drawImage(im, 0, 0, destW, destH);
      return c.toDataURL("image/png");
    } finally {
      g.restore();
    }
  }

  /** Flat rounded “frame missing” bitmap for reliable corners in viewers. */
  function placeholderRoundedPngDataUrl(w, h, r, label) {
    const dpr = Math.min(2, Math.max(1, Math.floor(900 / Math.max(w, h, 1))));
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d");
    if (!g) return null;
    g.clearRect(0, 0, cw, ch);
    g.save();
    g.scale(dpr, dpr);
    g.fillStyle = "rgb(30,31,36)";
    if (typeof g.roundRect === "function") {
      g.beginPath();
      g.roundRect(0, 0, w, h, r, r);
      g.fill();
      g.strokeStyle = "rgb(55,58,65)";
      g.lineWidth = 1;
      g.beginPath();
      g.roundRect(0, 0, w, h, r, r);
      g.stroke();
    } else {
      canvasRoundRectPath(g, 0, 0, w, h, r);
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = "rgb(55,58,65)";
      canvasRoundRectPath(g, 0, 0, w, h, r);
      g.stroke();
    }
    g.fillStyle = "rgb(128,130,138)";
    g.font = `${Math.max(12, Math.min(22, h * 0.06))}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, w / 2, h / 2);
    g.restore();
    return c.toDataURL("image/png");
  }

  function formatPdfPlatformLabel(platform) {
    const map = {
      youtube: "YouTube",
      vimeo: "Vimeo",
      loom: "Loom",
      googledrive: "Google Drive",
      dropbox: "Dropbox",
    };
    if (map[platform]) return map[platform];
    if (!platform) return "Video";
    return String(platform).replace(/^[a-z]/, (c) => c.toUpperCase());
  }

  async function generateCommentsPdf() {
    const clip = resolveClipContext();
    if (!clip) {
      showToast("No video context.");
      return;
    }
    if (!state.comments.length) {
      showToast("No comments to export.");
      return;
    }
    const JsPDF = globalThis.NotchJsPDF;
    if (typeof JsPDF !== "function") {
      showToast("PDF export unavailable — reload the page.");
      return;
    }
    const media = clip.getVideoElement();
    if (!media) {
      showToast("No video found.");
      return;
    }
    const raw = media instanceof HTMLVideoElement ? media : null;
    const driveEmbedOnly = clip.platform === "googledrive" && raw === null;
    if (!raw && !driveEmbedOnly) {
      showToast("Open a video page to include frames.");
      return;
    }
    if (raw && !raw.isConnected) {
      showToast("No video found.");
      return;
    }

    const exportBtn = root && root.querySelector('[data-action="export-pdf"]');
    if (exportBtn) exportBtn.disabled = true;

    showToast("Generating PDF…");
    const roots = state.comments.filter((c) => !c.parentId).sort((a, b) => a.ts - b.ts);
    const prevTime = Number.isFinite(media.currentTime) ? media.currentTime : 0;
    const wasPaused = raw ? raw.paused : false;
    if (raw) {
      raw.pause();
    } else {
      try {
        media.pause();
      } catch (_) {}
    }

    try {
      const rawRecord = await getClipRecordForDisplay(clip);
      const videoTitle = clipDisplayTitleFromRecord(rawRecord, clip);
      const doc = new JsPDF({
        unit: "px",
        format: [PDF_PAGE_PX.w, PDF_PAGE_PX.h],
        orientation: "landscape",
      });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = Math.round(pageW * 0.028);
      const maxTextW = pageW - 2 * margin;
      const cx = pageW / 2;

      pdfFillNotchPageBackground(doc, pageW, pageH);
      const pdfFonts = await registerNotchPdfRobotoFonts(doc);
      const face = pdfFonts.ok ? "Roboto" : "helvetica";
      const brandStyle = pdfFonts.ok && pdfFonts.black ? "black" : "bold";

      let videoPageUrl = "";
      try {
        videoPageUrl = typeof clip.openUrl === "function" ? String(clip.openUrl() || "") : "";
      } catch (_) {}
      if (!videoPageUrl) videoPageUrl = location.href;

      const titleStr = String(videoTitle);
      const titleMaxW = Math.min(maxTextW, Math.round(pageW * 0.78));
      doc.setFont(face, "bold");
      doc.setFontSize(28);
      const titleLineCount = doc.splitTextToSize(titleStr, titleMaxW).length;
      const lineHTitle = doc.internal.getLineHeight() / doc.internal.scaleFactor;
      const coverBlockH = pdfTitleCoverBlockHeight(doc, face, brandStyle, titleLineCount, lineHTitle);
      let y = Math.max(margin, Math.round((pageH - coverBlockH) / 2));

      doc.setFont(face, brandStyle);
      doc.setFontSize(88);
      doc.setTextColor(255, 255, 255);
      const wNotch = doc.getTextWidth("Notch");
      doc.setTextColor.apply(doc, NOTCH_PDF_ACCENT);
      const wDot = doc.getTextWidth(".");
      const brandX = cx - (wNotch + wDot) / 2;
      doc.setTextColor(255, 255, 255);
      doc.text("Notch", brandX, y);
      doc.setTextColor.apply(doc, NOTCH_PDF_ACCENT);
      doc.text(".", brandX + wNotch, y);
      y += PDF_COVER_GAP.afterBrand;

      doc.setFont(face, "normal");
      doc.setFontSize(22);
      doc.setTextColor.apply(doc, NOTCH_PDF_ACCENT);
      doc.text("Review report", cx, y, { align: "center" });
      y += PDF_COVER_GAP.subAfter;
      doc.setDrawColor.apply(doc, NOTCH_PDF_ACCENT);
      doc.setLineWidth(4);
      doc.line(cx - 260, y, cx + 260, y);
      y += PDF_COVER_GAP.ruleAfter;

      doc.setFont(face, "bold");
      doc.setFontSize(28);
      doc.setTextColor.apply(doc, NOTCH_PDF_ACCENT);
      doc.textWithLink(titleStr, cx, y, {
        url: videoPageUrl,
        align: "center",
        maxWidth: titleMaxW,
      });
      y += titleLineCount * lineHTitle + PDF_COVER_GAP.titleAfter;

      doc.setFont(face, "normal");
      doc.setFontSize(20);
      doc.setTextColor.apply(doc, NOTCH_PDF_MUTED);
      doc.text(formatPdfPlatformLabel(clip.platform), cx, y, { align: "center" });
      y += PDF_COVER_GAP.platAfter;

      doc.text(`Generated ${new Date().toLocaleString()}`, cx, y, { align: "center" });
      y += PDF_COVER_GAP.genAfter;
      doc.text(
        `${state.comments.length} comment${state.comments.length === 1 ? "" : "s"}`,
        cx,
        y,
        { align: "center" }
      );

      const maxImgW = maxTextW;
      const radiusFrac = 0.05;

      for (let i = 0; i < roots.length; i++) {
        const c = roots[i];
        const reps = repliesSortedForRoot(c.id);
        doc.addPage();
        pdfFillNotchPageBackground(doc, pageW, pageH);
        y = margin;

        let stillCap = null;
        try {
          stillCap = await captureVideoFrameCanvasForPdf(clip, c.ts);
        } catch (e) {
          console.error("Notch PDF frame", e);
        }

        const textBlock = (c.text || "").trim() || "(no text)";
        const commentTextLines = doc.splitTextToSize(textBlock, maxTextW);
        let markupDims = null;
        if (c.drawing && typeof c.drawing === "string" && c.drawing.startsWith("data:")) {
          try {
            const { w: dw, h: dh } = await naturalSizeFromDataUrl(c.drawing);
            if (dw > 0 && dh > 0) {
              markupDims = pdfFitImageMm(dw, dh, Math.min(maxImgW, Math.round(pageW * 0.42)), 140);
            }
          } catch {
            markupDims = null;
          }
        }

        const headH = PDF_COMMENT_GAP.head;
        const gapAfterStill = PDF_COMMENT_GAP.afterStill;
        const authorBlock = PDF_COMMENT_GAP.author;
        const afterH = PDF_COMMENT_GAP.afterBody;
        const markupLabelH = markupDims ? 18 + 12 : 0;
        const markupExtraH = markupDims ? markupDims.h + 18 : 0;
        const textH = commentTextLines.length * PDF_COMMENT_GAP.line;
        let replySectionH = 0;
        if (reps.length) {
          doc.setFont(face, "normal");
          doc.setFontSize(12);
          const replyW = maxTextW - 24;
          let replyLines = 0;
          for (const r of reps) {
            const replyBlock = `${String(r.author || "You")}: ${((r.text || "").trim() || "(no text)")}`;
            replyLines += doc.splitTextToSize(replyBlock, replyW).length;
          }
          replySectionH = 16 + replyLines * PDF_COMMENT_GAP.line + reps.length * 4 + 8;
        }
        const reservedBelowStill =
          gapAfterStill +
          authorBlock +
          textH +
          afterH +
          markupLabelH +
          markupExtraH +
          replySectionH +
          12;
        const maxImgH = Math.max(
          88,
          Math.min(
            Math.round(pageH * 0.48),
            pageH - margin - headH - margin - reservedBelowStill
          )
        );

        const defaultFrame = pdfFitImageMm(1920, 1080, maxImgW, maxImgH);
        let imgW = defaultFrame.w;
        let imgH = defaultFrame.h;
        if (stillCap && stillCap.w > 0 && stillCap.h > 0) {
          const fit = pdfFitImageMm(stillCap.w, stillCap.h, maxImgW, maxImgH);
          imgW = fit.w;
          imgH = fit.h;
        }

        const stillR = Math.min(imgW, imgH) * radiusFrac;

        doc.setFont(face, "bold");
        doc.setFontSize(17);
        doc.setTextColor.apply(doc, NOTCH_PDF_TEXT);
        doc.text(`#${i + 1} · ${formatTime(c.ts)}`, margin, y);
        y += headH;

        doc.setFont(face, "normal");
        if (stillCap && stillCap.canvas) {
          const roundedPng = rasterToRoundedPngDataUrl(stillCap.canvas, imgW, imgH, radiusFrac);
          if (roundedPng) {
            try {
              doc.addImage(roundedPng, "PNG", margin, y, imgW, imgH);
            } catch (e) {
              console.error("Notch PDF addImage still", e);
              const ph = placeholderRoundedPngDataUrl(imgW, imgH, stillR, "Frame not available");
              if (ph) doc.addImage(ph, "PNG", margin, y, imgW, imgH);
            }
          } else {
            const ph = placeholderRoundedPngDataUrl(imgW, imgH, stillR, "Frame not available");
            if (ph) doc.addImage(ph, "PNG", margin, y, imgW, imgH);
          }
        } else {
          const ph = placeholderRoundedPngDataUrl(imgW, imgH, stillR, "Frame not available");
          if (ph) doc.addImage(ph, "PNG", margin, y, imgW, imgH);
        }
        y += imgH + gapAfterStill;

        doc.setFontSize(14);
        doc.setTextColor.apply(doc, NOTCH_PDF_ACCENT);
        doc.text(String(c.author || "You"), margin, y);
        y += authorBlock;
        doc.setFont(face, "normal");
        doc.setFontSize(13);
        doc.setTextColor.apply(doc, NOTCH_PDF_TEXT);
        for (const line of commentTextLines) {
          doc.text(line, margin, y);
          y += PDF_COMMENT_GAP.line;
        }
        y += afterH;

        if (markupDims && c.drawing && typeof c.drawing === "string" && c.drawing.startsWith("data:")) {
          doc.setFont(face, "bold");
          doc.setFontSize(12);
          doc.setTextColor.apply(doc, NOTCH_PDF_MUTED);
          doc.text("Markup", margin, y);
          y += 18;
          doc.setFont(face, "normal");
          try {
            const mkRounded = await dataUrlToRoundedPngDataUrl(
              c.drawing,
              markupDims.w,
              markupDims.h,
              radiusFrac
            );
            if (mkRounded) doc.addImage(mkRounded, "PNG", margin, y, markupDims.w, markupDims.h);
            y += markupDims.h + 6;
          } catch (e) {
            console.error("Notch PDF markup", e);
            y += 4;
          }
        }

        if (reps.length) {
          y += 8;
          doc.setFont(face, "bold");
          doc.setFontSize(12);
          doc.setTextColor.apply(doc, NOTCH_PDF_MUTED);
          doc.text("Replies", margin, y);
          y += 16;
          doc.setFont(face, "normal");
          doc.setFontSize(12);
          doc.setTextColor.apply(doc, NOTCH_PDF_TEXT);
          const replyW = maxTextW - 24;
          for (const r of reps) {
            const replyBlock = `${String(r.author || "You")}: ${((r.text || "").trim() || "(no text)")}`;
            for (const line of doc.splitTextToSize(replyBlock, replyW)) {
              doc.text(line, margin + 18, y);
              y += PDF_COMMENT_GAP.line;
            }
            y += 4;
          }
        }
      }

      const fname = `notch-report_${sanitizeFilenamePart(clip.clipId)}_${formatExportStampForFilename()}.pdf`;
      doc.save(fname);
      showToast("PDF downloaded.");
    } catch (e) {
      console.error("Notch PDF export", e);
      showToast("Could not generate PDF.");
    } finally {
      try {
        media.currentTime = prevTime;
      } catch (_) {}
      if (!wasPaused) {
        try {
          void media.play();
        } catch (_) {}
      }
      if (exportBtn) exportBtn.disabled = false;
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
   * HTMLVideoElement when the browser allows it. Here we only unpaint layers this extension injects so
   * Notch itself does not occlude Drive's player for the few frames we capture.
   */
  async function suppressExtensionUIPaintDuringCapture(asyncWork) {
    const nodes = [];
    const markFrame = document.getElementById("markframe-root");
    if (markFrame?.isConnected) nodes.push(markFrame);
    document.body?.querySelectorAll(".mf-screengrab-flyout.mf-screengrab-flyout--portaled").forEach((n) => {
      if (n.isConnected) nodes.push(n);
    });
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

  async function captureGoogleDriveFrameViaVisibleTab() {
    return captureGoogleDriveVisibleTabPngDataUrl({ quiet: false });
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
        console.error("Notch screengrab blob", e);
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
      console.error("Notch screengrab blob", e);
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
      console.error("Notch screengrab clipboard", e);
      showToast("Could not copy image to clipboard.");
    }
  }

  async function copyReviewLink() {
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
      const r = await sendExtensionMessage({
        type: "MF_ENSURE_CLIP_REVIEW_ROW",
        platform: clip.platform,
        clipId: clip.clipId,
      });
      if (!r?.ok || !r.userId || !r.platform || r.clipId == null || String(r.clipId) === "") {
        const err = r?.error || "";
        if (err === "not_authenticated") showToast("Sign in to copy a review link.");
        else showToast("Could not prepare review link.");
        return;
      }
      const qs = new URLSearchParams({
        uid: String(r.userId),
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
      console.error(err);
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
      await refreshAuthorPresentationCache();
      renderThread();
      showToast("Imported review from link.");
      const u = new URL(location.href);
      u.searchParams.delete(MF_PARAM);
      history.replaceState(null, "", u.toString());
    } catch (e) {
      console.warn("Notch: could not import mf param", e);
    }
  }

  async function initReview(clip) {
    const mount = document.body || document.documentElement;
    if (!mount) return;

    if (root && root.parentNode !== mount) {
      mount.appendChild(root);
    }

    applyCompactRootLayout();

    if (state.dashboardForced) {
      setView("dashboard");
      const clipChanged = activeClipStorageKey !== clip.storageKey;
      if (clipChanged) {
        teardownCanvas();
        activeClipStorageKey = clip.storageKey;
      } else {
        teardownCanvas();
      }
      // Same clip_id but URL/sig changed (e.g. query params) or cloud session just became valid — refetch.
      if (clipChanged || isCloudActive()) {
        await loadClipData(clip);
        await tryImportFromUrl(clip);
      }
      await mergeClipMetadata(clip);
      root.classList.toggle("mf-collapsed", state.collapsed);
      await renderDashboard();
      return;
    }

    setView("watch");

    const clipChanged = activeClipStorageKey !== clip.storageKey;
    if (clipChanged) {
      teardownCanvas();
      activeClipStorageKey = clip.storageKey;
    }
    if (clipChanged || isCloudActive()) {
      await loadClipData(clip);
      await tryImportFromUrl(clip);
    }
    await mergeClipMetadata(clip);
    await refreshWatchVideoTitle(clip);
    await updateWatchHeaderSub(clip);

    root.classList.toggle("mf-collapsed", state.collapsed);

    await refreshAuthorPresentationCache();
    renderThread();

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
    const curRaw = await chrome.storage.local.get("notch_shared_review");
    const cur = curRaw.notch_shared_review;
    const base = cur && typeof cur === "object" ? { ...cur } : {};
    await chrome.storage.local.set({ notch_shared_review: { ...base, ...patch } });
  }

  async function handleOpenSharedReview(msg) {
    const uid = String(msg.uid || "").trim();
    const platform = msg.platform;
    const sharedClipId = msg.clip != null ? String(msg.clip) : "";
    if (!uid || !platform || !sharedClipId) return;

    const now = Date.now();
    if (now - openSharedReviewDedupAt < 800) return;
    openSharedReviewDedupAt = now;

    await setSidebarVisible(true);

    const clip = resolveClipContext();
    if (!clip || !clipMatchesRedeemTarget(clip, platform, sharedClipId)) {
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

  async function initDashboard() {
    const mount = document.body || document.documentElement;
    if (!mount) return;

    if (root && root.parentNode !== mount) {
      mount.appendChild(root);
    }

    setView("dashboard");

    if (activeClipStorageKey) {
      teardownCanvas();
      activeClipStorageKey = null;
    }
    applyCompactRootLayout();

    root.classList.toggle("mf-collapsed", state.collapsed);

    await renderDashboard();
  }

  function storageOnChanged(changes, area) {
    if (area !== "local") return;
    if (changes[STORAGE_KEYS.sidebarVisible]) {
      applySidebarVisibility(changes[STORAGE_KEYS.sidebarVisible].newValue !== false);
    }
    if (changes[STORAGE_KEYS.panelCorner]) {
      applyPanelCorner(changes[STORAGE_KEYS.panelCorner].newValue);
    }
    if (changes[STORAGE_KEYS.autoPauseCommentTyping]) {
      applyAutoPauseCommentTypingPref(changes[STORAGE_KEYS.autoPauseCommentTyping].newValue);
    }
    if (changes[STORAGE_KEYS.avatar] || changes[STORAGE_KEYS.author]) {
      void refreshAuthorPresentationCache()
        .then(() => {
          if (root && root.dataset.mfView === "watch" && root.dataset.mfLocked !== "1") renderThread();
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
      void refreshCloudUser(true).then(() => void tick());
    }
    const touched = Object.keys(changes).some(
      (k) => k.startsWith(STORAGE_KEYS.clipPrefix) || k.startsWith(STORAGE_KEYS.dataPrefix)
    );
    if (touched && root && root.dataset.mfView === "dashboard" && root.dataset.mfLocked !== "1") {
      renderDashboard();
    }
  }

  async function tick() {
    try {
      await tickInner();
    } catch (e) {
      if (isExtensionContextInvalidated(e)) return;
      console.warn("[Notch] tick", e);
    }
  }

  async function tickInner() {
    const href = location.href;
    const clip = resolveClipContext();

    await refreshCloudUser(false);
    let supabaseConfigured = false;
    try {
      const cfg = await sendExtensionMessage({ type: "MF_SUPABASE_CONFIG" });
      supabaseConfigured = !!cfg?.configured;
    } catch {
      supabaseConfigured = false;
    }
    const unlocked = supabaseConfigured && !!state.cloudUser;

    const mount = document.body || document.documentElement;
    if (!mount) return;

    let collabPart = "";
    if (clip && unlocked) {
      collabPart = (await readCollabHostUserIdForClip(clip)) || "";
    }

    const { notch_shared_review: nsr } = await chrome.storage.local.get("notch_shared_review");
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
      : state.dashboardForced
        ? "dash"
        : typeof clip.getOverlayParent === "function" && clip.getOverlayParent()
          ? "ov1"
          : "ov0";

    const sig = unlocked
      ? !clip
        ? href + "\0no_clip"
        : href +
          "\0" +
          clip.storageKey +
          "\0" +
          collabPart +
          "\0" +
          (state.dashboardForced ? "dashboard" : "watch") +
          "\0" +
          overlaySig
      : href + "\0gate\0" + String(supabaseConfigured);

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
    applyAppShellLocked(!unlocked);

    await applySidebarLayoutFromStorage();
    root.classList.toggle("mf-collapsed", state.collapsed);

    if (!unlocked) {
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
      teardownDriveYoutubeEmbedBridge();
      state.dashboardForced = false;
      await initDashboard();
      return;
    }

    if (clip.platform !== "googledrive") {
      teardownDriveYoutubeEmbedBridge();
    }

    await initReview(clip);
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
    document.addEventListener("yt-navigate-finish", () => {
      setTimeout(() => void tick(), 100);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _e, sendResponse) => {
    if (msg && msg.type === "TOGGLE_SIDEBAR") {
      loadSidebarVisible().then((v) => {
        setSidebarVisible(!v).then(() => sendResponse({ ok: true, sidebarVisible: !v }));
      });
      return true;
    }
    if (msg && msg.action === "open-shared-review") {
      void handleOpenSharedReview(msg)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
  });

  const mo = new MutationObserver(() => {
    clearTimeout(urlCheckTimer);
    urlCheckTimer = setTimeout(() => void tick(), 300);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(storageOnChanged);

  let compactLayoutResizeTid = null;
  window.addEventListener("resize", () => {
    clearTimeout(compactLayoutResizeTid);
    compactLayoutResizeTid = setTimeout(() => applyCompactRootLayout(), 150);
  });

  startUrlWatcher();
  void tick();
})();
