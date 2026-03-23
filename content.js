(function () {
  "use strict";

  if (window !== window.top) return;

  const ACCENT = "#00E5FF";
  /** Must match service worker Supabase auth storageKey. */
  const SUPABASE_AUTH_STORAGE_KEY = "sb-notch-auth";

  const STORAGE_KEYS = {
    author: "markframe_author",
    sidebarVisible: "markframe_sidebar_visible",
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
  /** Skip redundant init when DOM mutations fire but URL / clip / panel mode are unchanged (avoids panel flicker). */
  let lastTickSignature = "";
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
    hasInk: false,
    /** True while a clip is active but user chose "All reviews" (no navigation). */
    dashboardForced: false,
    /** When non-null, clip library reads/writes go to Supabase ({ email }). */
    cloudUser: null,
  };

  let cloudAuthCacheValidUntil = 0;
  let cloudAuthCachedUser = null;

  function sendExtensionMessage(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (r) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(r);
        });
      } catch (e) {
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
    cloudAuthCacheValidUntil = now + 45_000;
    try {
      const r = await sendExtensionMessage({ type: "MF_SUPABASE_SESSION" });
      if (!r?.configured) {
        cloudAuthCachedUser = null;
        state.cloudUser = null;
        return;
      }
      cloudAuthCachedUser = r.user && r.user.email ? { email: r.user.email } : null;
      state.cloudUser = cloudAuthCachedUser;
    } catch {
      cloudAuthCachedUser = null;
      state.cloudUser = null;
    }
  }

  function isCloudActive() {
    return !!state.cloudUser;
  }

  async function updateSyncBar() {
    if (!root) return;
    const bar = root.querySelector(".mf-sync-bar");
    if (!bar) return;
    const msg = bar.querySelector(".mf-sync-msg");
    const outBtn = bar.querySelector('[data-action="sign-out"]');
    if (!msg || !outBtn) return;
    if (state.cloudUser?.email) {
      msg.textContent = "Signed in as " + state.cloudUser.email + ".";
      outBtn.classList.remove("mf-hidden");
    } else {
      msg.textContent = "";
      outBtn.classList.add("mf-hidden");
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
    setGateStatus("");
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
      msgEl.textContent = "Enter your email and password, or create an account.";
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
      h === "www.youtube-nocookie.com" ||
      h === "youtube-nocookie.com"
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

  /** Watch `?v=` or embed `/embed/VIDEO_ID` (and youtube-nocookie). */
  function parseYoutubeVideoId() {
    if (!isYoutubeSite()) return null;
    try {
      const u = new URL(location.href);
      const fromQuery = u.searchParams.get("v");
      if (fromQuery) return fromQuery;
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

  function findGoogleDriveNativeVideo() {
    const selectors = [
      "#drive-viewer video",
      ".drive-viewer-root video",
      ".drive-viewer-paginated-scrollable video",
      "div[role='main'] video",
      "video",
    ];
    for (const sel of selectors) {
      const v = document.querySelector(sel);
      if (googleDriveVideoIsUsable(v)) return v;
    }
    const videos = [...document.querySelectorAll("video")].filter(googleDriveVideoIsUsable);
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

  /** Shared file preview paths (video or other); we only attach when a usable <video> exists. */
  function isDropboxShareViewerPath(pathname) {
    if (!pathname || typeof pathname !== "string") return false;
    if (/^\/s\/[^/]+\/.+/i.test(pathname)) return true;
    if (/^\/scl\/fi\/[^/]+\/.+/i.test(pathname)) return true;
    // Shared-folder file links, e.g. /scl/fo/<folderToken>/<fileToken>/name.mov
    if (/^\/scl\/fo\/[^/]+\/[^/]+\/.+/i.test(pathname)) return true;
    return false;
  }

  function normalizeDropboxClipPath(pathname, searchParams) {
    if (!pathname || !searchParams) return null;
    const keys = [...new Set([...searchParams.keys()])].sort();
    const pairs = [];
    for (const k of keys) {
      const v = searchParams.get(k);
      if (v != null && v !== "") pairs.push(k + "=" + encodeURIComponent(v));
    }
    const q = pairs.length ? "?" + pairs.join("&") : "";
    return pathname + q;
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
    return Boolean(na && nb && na === nb);
  }

  function isDropboxClipHost() {
    if (!isDropboxSite()) return false;
    return !!parseDropboxClipId();
  }

  function dropboxClipPathInUrl(urlStr, expectedPath) {
    if (!urlStr || !expectedPath) return false;
    const parsed = parseDropboxClipIdFromUrlString(urlStr);
    return parsed === expectedPath;
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
    if (!findDropboxNativeVideo()) return null;
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
    if (isCloudActive()) {
      const r = await sendExtensionMessage({
        type: "MF_CLOUD_LOAD_CLIP",
        platform: clip.platform,
        clipId: clip.clipId,
      });
      return r?.ok ? r.record : null;
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
    if (root.dataset.mfView === "watch") {
      const sub = root.querySelector(".mf-header-sub");
      if (sub) {
        sub.textContent = title;
        sub.classList.add("mf-header-sub-dynamic");
      }
    }
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function legacyYoutubeKey(youtubeId) {
    return STORAGE_KEYS.dataPrefix + youtubeId;
  }

  async function loadAuthor() {
    const { [STORAGE_KEYS.author]: name } = await chrome.storage.local.get(STORAGE_KEYS.author);
    return typeof name === "string" && name.trim() ? name.trim() : "You";
  }

  async function saveAuthor(name) {
    await chrome.storage.local.set({ [STORAGE_KEYS.author]: name });
  }

  async function loadSidebarVisible() {
    const { [STORAGE_KEYS.sidebarVisible]: v } = await chrome.storage.local.get(
      STORAGE_KEYS.sidebarVisible
    );
    return v !== false;
  }

  async function setSidebarVisible(visible) {
    await chrome.storage.local.set({ [STORAGE_KEYS.sidebarVisible]: !!visible });
    applySidebarVisibility(visible);
  }

  function applySidebarVisibility(visible) {
    if (root) root.classList.toggle("mf-hidden", !visible);
    if (canvasHost && !state.drawMode) canvasHost.style.visibility = visible ? "visible" : "hidden";
  }

  /** Tighter panel on small viewports. */
  function applyCompactRootLayout() {
    if (!root) return;
    root.dataset.mfCompact =
      window.innerWidth < 480 || window.innerHeight < 360 ? "1" : "";
  }

  function normalizeCommentsShape() {
    for (const c of state.comments) {
      if (typeof c.complete !== "boolean") {
        c.complete = c.reaction === "approve";
      }
      delete c.reaction;
    }
  }

  async function loadClipData(clip) {
    await refreshCloudUser(false);
    const key = clip.storageKey;
    if (isCloudActive()) {
      const r = await sendExtensionMessage({
        type: "MF_CLOUD_LOAD_CLIP",
        platform: clip.platform,
        clipId: clip.clipId,
      });
      const raw = r?.ok ? r.record : null;
      if (raw && Array.isArray(raw.comments)) {
        state.comments = raw.comments;
        normalizeCommentsShape();
      } else {
        state.comments = [];
      }
      return;
    }
    let { [key]: raw } = await chrome.storage.local.get(key);
    if (!raw && clip.platform === "youtube") {
      const leg = legacyYoutubeKey(clip.clipId);
      const got = await chrome.storage.local.get(leg);
      raw = got[leg];
      if (raw && Array.isArray(raw.comments)) {
        await chrome.storage.local.set({ [key]: raw });
      }
    }
    if (raw && Array.isArray(raw.comments)) {
      state.comments = raw.comments;
      normalizeCommentsShape();
    } else {
      state.comments = [];
    }
  }

  async function saveClipData(clip) {
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
      comments: state.comments,
      updatedAt: Date.now(),
      title,
      thumbnailUrl,
      platform: clip.platform,
      clipId: clip.clipId,
    };
    if (isCloudActive()) {
      try {
        const r = await sendExtensionMessage({
          type: "MF_CLOUD_SAVE_CLIP",
          platform: clip.platform,
          clipId: clip.clipId,
          comments: state.comments,
          title,
          thumbnailUrl,
        });
        if (!r?.ok) showToast("Could not save to cloud — check your connection.");
      } catch (e) {
        console.error("Notch cloud save", e);
        showToast("Could not save to cloud — check your connection.");
      }
      return;
    }
    await chrome.storage.local.set({ [key]: payload });
  }

  async function mergeClipMetadata(clip) {
    await refreshCloudUser(false);
    const key = clip.storageKey;
    let prev = null;
    if (isCloudActive()) {
      const r = await sendExtensionMessage({
        type: "MF_CLOUD_LOAD_CLIP",
        platform: clip.platform,
        clipId: clip.clipId,
      });
      prev = r?.ok ? r.record : null;
    } else {
      const got = await chrome.storage.local.get(key);
      prev = got[key];
    }
    if (!prev || !Array.isArray(prev.comments) || prev.comments.length === 0) return;
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
    if (isCloudActive()) {
      try {
        await sendExtensionMessage({
          type: "MF_CLOUD_SAVE_CLIP",
          platform: clip.platform,
          clipId: clip.clipId,
          comments: prev.comments,
          title: nextTitle,
          thumbnailUrl: nextThumb,
        });
      } catch (e) {
        console.error("Notch cloud merge", e);
      }
      return;
    }
    const next = { ...prev, title: nextTitle, thumbnailUrl: nextThumb };
    delete next.customTitle;
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
    if (isCloudActive()) {
      const r = await sendExtensionMessage({ type: "MF_CLOUD_LIST_CLIPS" });
      const out = r?.ok && Array.isArray(r.items) ? r.items : [];
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
    if (isCloudActive()) {
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
    } else {
      const keys = storageKeysForDashboardItem(item);
      await chrome.storage.local.remove(keys);
    }

    const cur = resolveClipContext();
    const isCurrentPageClip =
      cur && cur.platform === item.platform && cur.clipId === item.clipId;
    const hadThisKeyLoaded =
      activeClipStorageKey != null && keys.includes(activeClipStorageKey);

    if (isCurrentPageClip || hadThisKeyLoaded) {
      activeClipStorageKey = null;
      state.comments = [];
      state.selectedId = null;
      teardownCanvas();
      if (root && root.dataset.mfView === "watch") {
        renderThread();
      }
    }
  }

  async function compressToBase64Url(obj) {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    let binary = "";
    const u8 = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
    let best = state.comments[0].id;
    let bestDiff = Infinity;
    for (const c of state.comments) {
      const d = Math.abs((c.ts || 0) - currentSec);
      if (d < bestDiff) {
        bestDiff = d;
        best = c.id;
      }
    }
    return bestDiff <= 5 ? best : null;
  }

  async function saveDrawingToComment() {
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
      c.drawing = png;
      await saveClipData(clip);
      renderThread();
      clearCanvasVisuals();
      showToast("Drawing saved to nearest comment.");
    }
  }

  function seekTo(sec) {
    videoEl = getActiveVideoEl();
    if (videoEl && Number.isFinite(sec)) {
      videoEl.currentTime = sec;
      try {
        videoEl.play();
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

  async function addComment(text) {
    const clip = resolveClipContext();
    if (!clip) return;
    videoEl = clip.getVideoElement();
    const ts = videoEl && Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
    const author = (root.querySelector(".mf-author-input") || {}).value || (await loadAuthor());
    const c = {
      id: uid(),
      ts,
      text: String(text).trim(),
      author,
      complete: false,
    };
    state.comments.push(c);
    await saveClipData(clip);
    renderThread();
  }

  function setCommentComplete(id, complete) {
    const c = state.comments.find((x) => x.id === id);
    if (!c) return;
    c.complete = !!complete;
    delete c.reaction;
    const clip = resolveClipContext();
    if (clip) void saveClipData(clip);
    renderThread();
  }

  function renderThread() {
    if (!root) return;
    const thread = root.querySelector(".mf-thread");
    if (!thread) return;
    thread.innerHTML = "";
    if (!state.comments.length) {
      const empty = document.createElement("div");
      empty.className = "mf-empty";
      empty.textContent = "No comments yet. Pause, type, and press Enter to capture this frame.";
      thread.appendChild(empty);
      return;
    }

    const sorted = [...state.comments].sort((a, b) => a.ts - b.ts);
    for (const c of sorted) {
      const el = document.createElement("div");
      el.className = "mf-comment";
      if (state.selectedId === c.id) el.classList.add("mf-selected");
      if (!c.complete) el.classList.add("mf-incomplete");

      const top = document.createElement("div");
      top.className = "mf-comment-top";

      const tsBtn = document.createElement("button");
      tsBtn.type = "button";
      tsBtn.className = "mf-ts";
      tsBtn.textContent = formatTime(c.ts);
      tsBtn.addEventListener("click", () => {
        state.selectedId = c.id;
        seekTo(c.ts);
        if (c.drawing) overlayDrawingPreview(c.drawing);
        renderThread();
      });

      const auth = document.createElement("span");
      auth.className = "mf-author";
      auth.textContent = c.author || "You";

      const doneWrap = document.createElement("div");
      doneWrap.className = "mf-complete-wrap";
      const statusBtn = document.createElement("button");
      statusBtn.type = "button";
      statusBtn.className = "mf-status-btn" + (c.complete ? " mf-on" : "");
      statusBtn.setAttribute("aria-pressed", c.complete ? "true" : "false");
      statusBtn.title = c.complete ? "Mark incomplete" : "Mark complete";
      statusBtn.appendChild(createLucideCircleCheckIcon());
      statusBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setCommentComplete(c.id, !c.complete);
      });
      doneWrap.appendChild(statusBtn);

      top.appendChild(tsBtn);
      top.appendChild(auth);
      top.appendChild(doneWrap);

      const text = document.createElement("div");
      text.className = "mf-comment-text";
      text.textContent = c.text;

      el.appendChild(top);
      el.appendChild(text);

      if (c.drawing) {
        const row = document.createElement("div");
        row.className = "mf-drawing-row";
        const img = document.createElement("img");
        img.className = "mf-drawing-thumb";
        img.src = c.drawing;
        img.alt = "Annotation";
        img.addEventListener("click", () => {
          state.selectedId = c.id;
          overlayDrawingPreview(c.drawing);
          renderThread();
        });
        row.appendChild(img);
        el.appendChild(row);
      }

      thread.appendChild(el);
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
          <p class="mf-gate-status" aria-live="polite"></p>
          <div class="mf-gate-actions">
            <button type="button" class="mf-btn mf-btn-primary" data-action="gate-sign-in">Sign in</button>
            <button type="button" class="mf-btn" data-action="gate-sign-up">Create account</button>
          </div>
        </div>
      </div>
      <div class="mf-app-shell mf-hidden">
        <div class="mf-header">
          <div class="mf-header-text">
            <div class="mf-brand">Notch</div>
            <div class="mf-header-sub"></div>
          </div>
          <div class="mf-header-actions">
            <button type="button" class="mf-back-dashboard" data-action="go-dashboard" title="All reviewed videos">
              ← All reviews
            </button>
            <button type="button" class="mf-back-watch" data-action="go-watch-panel" title="Notes for this video">
              This video
            </button>
            <button type="button" class="mf-collapse" data-action="collapse" title="Collapse">▾</button>
          </div>
        </div>
        <div class="mf-watch-pane">
          <div class="mf-watch-video-title-wrap">
            <span class="mf-watch-video-title" role="status" aria-live="polite"></span>
          </div>
          <div class="mf-author-row">
            <label for="mf-author">Name</label>
            <input type="text" id="mf-author" class="mf-author-input" maxlength="80" placeholder="Display name" />
          </div>
          <div class="mf-toolbar">
            <button type="button" class="mf-btn" data-action="toggle-draw">Draw</button>
            <input type="color" class="mf-color" data-action="color" value="#00E5FF" aria-label="Stroke color" />
            <button type="button" class="mf-btn mf-btn-primary" data-action="save-draw">Save drawing</button>
            <button type="button" class="mf-btn" data-action="copy-link">Copy review link</button>
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
          <div class="mf-sync-bar">
            <p class="mf-sync-msg"></p>
            <div class="mf-sync-actions">
              <button type="button" class="mf-btn mf-sync-out" data-action="sign-out">Sign out</button>
            </div>
          </div>
          <div class="mf-dashboard-list"></div>
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
      sub.classList.remove("mf-header-sub-dynamic");
      if (mode === "dashboard") {
        sub.textContent = "Your reviews";
      } else {
        sub.textContent = "";
      }
    }
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

  async function renderDashboard() {
    if (!root) return;
    await refreshCloudUser(false);
    await updateSyncBar();
    updateOffClipBanner();
    const listEl = root.querySelector(".mf-dashboard-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    const items = await listVideosWithFeedback();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mf-dashboard-empty";
      empty.textContent =
        "No reviews yet. Open a YouTube, Vimeo, Loom, Google Drive, or Dropbox video and add a note.";
      listEl.appendChild(empty);
      return;
    }
    for (const item of items) {
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
      delBtn.setAttribute("aria-label", "Delete saved notes for this video");
      delBtn.title = "Delete from library";
      delBtn.textContent = "×";
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

      row.appendChild(card);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
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
    });

    const authorInp = root.querySelector(".mf-author-input");
    loadAuthor().then((n) => {
      authorInp.value = n;
    });
    authorInp.addEventListener("change", () => saveAuthor(authorInp.value));

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
          void submitGateSignIn();
        }
      });
    }

    const signOutBtn = root.querySelector('[data-action="sign-out"]');
    if (signOutBtn) {
      signOutBtn.addEventListener("click", async () => {
        try {
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

    root.querySelector('[data-action="copy-link"]').addEventListener("click", () => {
      copyReviewLink();
    });

    const commentInp = root.querySelector(".mf-comment-input");
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

  async function copyReviewLink() {
    const clip = resolveClipContext();
    if (!clip) return;
    const payload = {
      v: 2,
      platform: clip.platform,
      clipId: clip.clipId,
      comments: state.comments,
    };
    try {
      const enc = await compressToBase64Url(payload);
      const url = `https://markframe.io/review?data=${enc}`;
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
      state.comments = data.comments;
      normalizeCommentsShape();
      await saveClipData(clip);
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
      if (activeClipStorageKey !== clip.storageKey) {
        teardownCanvas();
        activeClipStorageKey = clip.storageKey;
        await loadClipData(clip);
        await tryImportFromUrl(clip);
      } else {
        teardownCanvas();
      }
      await mergeClipMetadata(clip);
      const visible = await loadSidebarVisible();
      applySidebarVisibility(visible);
      root.classList.toggle("mf-collapsed", state.collapsed);
      await renderDashboard();
      return;
    }

    setView("watch");

    if (activeClipStorageKey !== clip.storageKey) {
      teardownCanvas();
      activeClipStorageKey = clip.storageKey;
      await loadClipData(clip);
      await tryImportFromUrl(clip);
    }
    await mergeClipMetadata(clip);
    await refreshWatchVideoTitle(clip);

    const visible = await loadSidebarVisible();
    applySidebarVisibility(visible);
    root.classList.toggle("mf-collapsed", state.collapsed);

    renderThread();

    ensureCanvasOverlay(clip);
    videoEl = clip.getVideoElement();
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

    const visible = await loadSidebarVisible();
    applySidebarVisibility(visible);
    root.classList.toggle("mf-collapsed", state.collapsed);

    await renderDashboard();
  }

  function storageOnChanged(changes, area) {
    if (area !== "local") return;
    if (changes[STORAGE_KEYS.sidebarVisible]) {
      applySidebarVisibility(changes[STORAGE_KEYS.sidebarVisible].newValue !== false);
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

    const sig = unlocked
      ? !clip
        ? href + "\0no_clip"
        : href + "\0" + clip.storageKey + "\0" + (state.dashboardForced ? "dashboard" : "watch")
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

    const visible = await loadSidebarVisible();
    applySidebarVisibility(visible);
    root.classList.toggle("mf-collapsed", state.collapsed);

    if (!unlocked) {
      teardownDriveYoutubeEmbedBridge();
      teardownCanvas();
      activeClipStorageKey = null;
      state.comments = [];
      state.selectedId = null;
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "TOGGLE_SIDEBAR") {
      loadSidebarVisible().then((v) => {
        setSidebarVisible(!v).then(() => sendResponse({ ok: true, sidebarVisible: !v }));
      });
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
