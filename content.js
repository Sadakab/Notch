(function () {
  "use strict";

  if (window !== window.top) return;

  const ACCENT = "#00E5FF";
  const STORAGE_KEYS = {
    author: "markframe_author",
    sidebarVisible: "markframe_sidebar_visible",
    /** @deprecated legacy YouTube-only */
    dataPrefix: "markframe_video_",
    clipPrefix: "markframe_clip_",
  };

  const CLIP_PLATFORMS = ["youtube", "vimeo", "generic"];

  function clipStorageKey(platform, clipId) {
    return STORAGE_KEYS.clipPrefix + platform + "_" + encodeURIComponent(clipId);
  }

  function parseClipStorageKey(key) {
    const p = STORAGE_KEYS.clipPrefix;
    if (!key.startsWith(p)) return null;
    const rest = key.slice(p.length);
    for (const plat of CLIP_PLATFORMS) {
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
  let resizeObs = null;
  let urlCheckTimer = null;
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
    /** Next click on a <video> binds generic review (capture phase). */
    pickVideoMode: false,
    /** Fingerprint from genericClipFingerprint for bound generic video. */
    genericPickedFingerprint: null,
  };

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

  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    return Math.abs(h).toString(36);
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

  function findLargestVisibleVideo() {
    const videos = [...document.querySelectorAll("video")];
    let best = null;
    let bestArea = 0;
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;
    const minArea = 4000;
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

  function genericClipFingerprint(video) {
    const page = location.origin + location.pathname;
    const src = video.currentSrc || video.src || "";
    if (/^https?:\/\//i.test(src)) {
      return simpleHash(page + "|" + src);
    }
    const all = [...document.querySelectorAll("video")];
    const idx = all.indexOf(video);
    return simpleHash(page + "|idx" + Math.max(0, idx));
  }

  function getGenericOverlayParent(video) {
    const parent = video.parentElement;
    if (parent) {
      const cs = getComputedStyle(parent);
      if (cs.position === "static") {
        parent.style.position = "relative";
      }
      return parent;
    }
    return video;
  }

  function scrapeGenericMetadata(video) {
    const poster = video.getAttribute("poster");
    const thumb = poster && /^https?:/i.test(poster) ? poster : null;
    let title = (document.title || "").trim() || null;
    return {
      title,
      thumbnailUrl: thumb,
      trusted: true,
      staleThumb: false,
    };
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

  function resolveGenericClip() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return null;
    if (isYoutubeSite() || isVimeoClipHost()) return null;

    let video = null;
    if (state.genericPickedFingerprint) {
      for (const v of document.querySelectorAll("video")) {
        if (genericClipFingerprint(v) === state.genericPickedFingerprint) {
          video = v;
          break;
        }
      }
      if (!video) state.genericPickedFingerprint = null;
    }
    if (!video) {
      video = findLargestVisibleVideo();
    }
    if (!video) return null;

    const clipId = genericClipFingerprint(video);
    const storageKey = clipStorageKey("generic", clipId);
    return {
      platform: "generic",
      clipId,
      storageKey,
      openUrl: () => location.href.split("#")[0],
      getVideoElement: () => video,
      getOverlayParent: () => getGenericOverlayParent(video),
      scrapeMetadata: () => scrapeGenericMetadata(video),
    };
  }

  function resolveClipContext() {
    return resolveYoutubeClip() || resolveVimeoClip() || resolveGenericClip();
  }

  function clipsMatch(a, b) {
    return a && b && a.platform === b.platform && a.clipId === b.clipId;
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
    const key = clip.storageKey;
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

    const payload = {
      comments: state.comments,
      updatedAt: Date.now(),
      title,
      thumbnailUrl,
      platform: clip.platform,
      clipId: clip.clipId,
      ...(clip.platform === "generic" ? { pageUrl: clip.openUrl() } : {}),
    };
    await chrome.storage.local.set({ [key]: payload });
  }

  async function mergeClipMetadata(clip) {
    const key = clip.storageKey;
    const { [key]: prev } = await chrome.storage.local.get(key);
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
    if (nextTitle === prev.title && nextThumb === prev.thumbnailUrl) return;
    await chrome.storage.local.set({
      [key]: {
        ...prev,
        title: nextTitle,
        thumbnailUrl: nextThumb,
      },
    });
  }

  function defaultThumbForPlatform(platform, clipId) {
    if (platform === "youtube") return defaultYoutubeThumbnail(clipId);
    if (platform === "vimeo") return defaultVimeoThumbnail(clipId);
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

  async function listVideosWithFeedback() {
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
      } else {
        openUrl = v.pageUrl || "";
      }

      const titleDefault =
        platform === "youtube"
          ? "YouTube video"
          : platform === "vimeo"
            ? "Vimeo video"
            : "Video";

      out.push({
        storageKey: k,
        platform,
        clipId,
        title: v.title || titleDefault,
        thumbnailUrl: thumb || defaultThumbForPlatform(platform, clipId) || "",
        commentCount: v.comments.length,
        updatedAt: v.updatedAt || 0,
        openUrl,
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const row of out) {
      if (row.platform !== "vimeo" || row.thumbnailUrl) continue;
      const o = await fetchVimeoThumbFromBackground(row.clipId);
      if (!o) continue;
      row.thumbnailUrl = o;
      const sk = row.storageKey;
      const got = await chrome.storage.local.get(sk);
      const rec = got[sk];
      if (rec && !rec.thumbnailUrl) {
        await chrome.storage.local.set({ [sk]: { ...rec, thumbnailUrl: o } });
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
    const keys = storageKeysForDashboardItem(item);
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
        <div class="mf-author-row">
          <label for="mf-author">Name</label>
          <input type="text" id="mf-author" class="mf-author-input" maxlength="80" placeholder="Display name" />
        </div>
        <div class="mf-toolbar">
          <button type="button" class="mf-btn mf-pick-video mf-hidden" data-action="pick-video" title="Click, then click a video on the page">
            Pick video
          </button>
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
        <div class="mf-dashboard-list"></div>
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
      sub.textContent = mode === "dashboard" ? "Your reviews" : "This video";
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
        "No video detected on this page. Use YouTube, Vimeo, or a page with an HTML5 video—or open a saved item below.";
    }
  }

  async function renderDashboard() {
    if (!root) return;
    updateOffClipBanner();
    const listEl = root.querySelector(".mf-dashboard-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    const items = await listVideosWithFeedback();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mf-dashboard-empty";
      empty.textContent =
        "No reviews yet. Open a supported video (YouTube, Vimeo, or a page with HTML5 video) and add a note.";
      listEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "mf-dash-row";

      const card = document.createElement("button");
      card.type = "button";
      card.className = "mf-dash-card";
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
        if (cur && cur.platform === item.platform && cur.clipId === item.clipId) {
          setDrawModeUi(false);
          tick();
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
    root.querySelector('[data-action="go-dashboard"]').addEventListener("click", () => {
      state.dashboardForced = true;
      setDrawModeUi(false);
      tick();
    });

    root.querySelector('[data-action="go-watch-panel"]').addEventListener("click", () => {
      state.dashboardForced = false;
      setDrawModeUi(false);
      tick();
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

    const pickBtn = root.querySelector('[data-action="pick-video"]');
    if (pickBtn) {
      pickBtn.addEventListener("click", () => {
        if (state.pickVideoMode) {
          setPickVideoMode(false);
        } else {
          setPickVideoMode(true);
          showToast("Click a video on the page.");
        }
      });
    }

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

  function refreshPickVideoUi() {
    if (!root) return;
    const btn = root.querySelector('[data-action="pick-video"]');
    if (!btn) return;
    const show = !isYoutubeSite() && !isVimeoClipHost();
    btn.classList.toggle("mf-hidden", !show);
    btn.classList.toggle("mf-active", state.pickVideoMode);
  }

  let pickVideoPointerHandler = null;

  function setPickVideoMode(on) {
    state.pickVideoMode = !!on;
    if (on) {
      pickVideoPointerHandler = (e) => {
        if (!state.pickVideoMode) return;
        const t = e.target;
        if (t.closest && t.closest("#markframe-root")) return;
        const v = t.closest && t.closest("video");
        if (!v) return;
        e.preventDefault();
        e.stopPropagation();
        state.genericPickedFingerprint = genericClipFingerprint(v);
        setPickVideoMode(false);
        showToast("Video selected.");
        tick();
      };
      document.addEventListener("pointerdown", pickVideoPointerHandler, true);
    } else if (pickVideoPointerHandler) {
      document.removeEventListener("pointerdown", pickVideoPointerHandler, true);
      pickVideoPointerHandler = null;
    }
    refreshPickVideoUi();
  }

  async function initReview(clip) {
    const mount = document.body || document.documentElement;
    if (!mount) return;

    if (!root) {
      root = buildSidebarHtml();
      mount.appendChild(root);
      wireSidebar();
    } else if (root.parentNode !== mount) {
      mount.appendChild(root);
    }

    refreshPickVideoUi();
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

    if (!root) {
      root = buildSidebarHtml();
      mount.appendChild(root);
      wireSidebar();
    } else if (root.parentNode !== mount) {
      mount.appendChild(root);
    }

    setView("dashboard");

    if (activeClipStorageKey) {
      teardownCanvas();
      activeClipStorageKey = null;
    }
    refreshPickVideoUi();
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
    const touched = Object.keys(changes).some(
      (k) => k.startsWith(STORAGE_KEYS.clipPrefix) || k.startsWith(STORAGE_KEYS.dataPrefix)
    );
    if (touched && root && root.dataset.mfView === "dashboard") {
      renderDashboard();
    }
  }

  function tick() {
    const clip = resolveClipContext();
    if (!clip) {
      state.dashboardForced = false;
      initDashboard();
      return;
    }
    initReview(clip);
  }

  function startUrlWatcher() {
    let last = location.href;
    const check = () => {
      if (location.href !== last) {
        last = location.href;
        tick();
      }
    };
    setInterval(check, 800);
    document.addEventListener("yt-navigate-finish", () => {
      setTimeout(tick, 100);
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
    urlCheckTimer = setTimeout(tick, 300);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(storageOnChanged);

  let compactLayoutResizeTid = null;
  window.addEventListener("resize", () => {
    clearTimeout(compactLayoutResizeTid);
    compactLayoutResizeTid = setTimeout(() => applyCompactRootLayout(), 150);
  });

  startUrlWatcher();
  tick();
})();
