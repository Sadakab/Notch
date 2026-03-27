import { isClientSafeSupabaseKey } from "./supabase-client-key.js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";
import {
  handleRuntimeMessage,
  invalidateSupabaseClient,
  restoreAuthMarker,
  syncAuthMarkerFromChromeStorage,
} from "./sw-cloud.js";

const CLOUD_TYPES = new Set([
  "MF_AUTH_SIGN_IN",
  "MF_AUTH_SIGN_UP",
  "MF_AUTH_CHANGED",
  "MF_SUPABASE_SESSION",
  "MF_SUPABASE_SIGN_OUT",
  "MF_CLOUD_LOAD_CLIP",
  "MF_CLOUD_SAVE_CLIP",
  "MF_CLOUD_LIST_CLIPS",
  "MF_CLOUD_UPDATE_THUMB",
  "MF_CLOUD_DELETE_CLIP",
  "MF_ENSURE_CLIP_REVIEW_ROW",
  "MF_JOIN_SHARED_REVIEW",
  "MF_COLLAB_LEAVE",
]);

function isSupabaseConfigured() {
  return !!(SUPABASE_URL && isClientSafeSupabaseKey(SUPABASE_ANON_KEY));
}

function isInjectableUrl(url) {
  try {
    const u = new URL(url || "");
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const NOTCH_SHARED_REVIEW_STORAGE_KEY = "notch_shared_review";

/** Matches `buildWatchUrlForPlatform` / Dropbox open URL in content.js. */
function buildWatchUrlForSharedReview(platform, clipIdRaw) {
  if (clipIdRaw == null) return "";
  const clipId = String(clipIdRaw);
  if (!clipId.trim()) return "";
  if (platform === "youtube") {
    return "https://www.youtube.com/watch?v=" + encodeURIComponent(clipId);
  }
  if (platform === "vimeo") {
    return "https://vimeo.com/" + encodeURIComponent(clipId);
  }
  if (platform === "loom") {
    return "https://www.loom.com/share/" + encodeURIComponent(clipId);
  }
  if (platform === "googledrive") {
    return "https://drive.google.com/file/d/" + encodeURIComponent(clipId) + "/view";
  }
  if (platform === "dropbox") {
    if (clipId.startsWith("http")) return clipId;
    if (!clipId.startsWith("/")) {
      return "https://www.dropbox.com/";
    }
    try {
      const qIdx = clipId.indexOf("?");
      const pathOnly = qIdx === -1 ? clipId : clipId.slice(0, qIdx);
      const search = qIdx === -1 ? "" : clipId.slice(qIdx);
      const segments = pathOnly
        .split("/")
        .filter(Boolean)
        .map((seg) => encodeURIComponent(decodeURIComponent(seg)));
      return "https://www.dropbox.com/" + segments.join("/") + search;
    } catch {
      return "https://www.dropbox.com/";
    }
  }
  return "";
}

/** Chrome tab `url` match patterns to find an already-open video tab. */
function tabUrlPatternsForSharedReview(platform, clipIdRaw) {
  const clipId = encodeURIComponent(String(clipIdRaw ?? ""));
  if (platform === "youtube") {
    return [
      `*://www.youtube.com/watch?v=${clipId}*`,
      `*://youtube.com/watch?v=${clipId}*`,
      `*://m.youtube.com/watch?v=${clipId}*`,
      `*://youtu.be/${clipId}*`,
    ];
  }
  if (platform === "vimeo") {
    return [`*://vimeo.com/${clipId}*`, `*://player.vimeo.com/video/${clipId}*`];
  }
  if (platform === "loom") {
    return [`*://www.loom.com/share/${clipId}*`];
  }
  if (platform === "googledrive") {
    return [`*://drive.google.com/file/d/${clipId}/*`, `*://docs.google.com/file/d/${clipId}/*`];
  }
  if (platform === "dropbox") {
    const full = buildWatchUrlForSharedReview(platform, clipIdRaw);
    return full && full !== "https://www.dropbox.com/" ? [`${full}*`] : [];
  }
  return [];
}

async function focusTab(tab) {
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

/**
 * Finds an injectable tab for this clip, focuses it, or creates a new tab to the watch URL.
 * @returns {Promise<number | null>} tab id
 */
async function findOrOpenTabForSharedReview(platform, clipId) {
  const patterns = tabUrlPatternsForSharedReview(platform, clipId);
  for (const pattern of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      const hit = tabs.find((t) => t.id != null && isInjectableUrl(t.url));
      if (hit) {
        await focusTab(hit);
        return hit.id;
      }
    } catch {
      /* ignore malformed pattern */
    }
  }
  const openUrl = buildWatchUrlForSharedReview(platform, clipId);
  if (!openUrl || !isInjectableUrl(openUrl)) return null;
  const created = await chrome.tabs.create({ url: openUrl, active: true });
  return created?.id ?? null;
}

/** Deliver to content script (background cannot reach CS via runtime.sendMessage). */
async function dispatchOpenSharedReviewToTab(tabId, payload) {
  const sendOnce = () => chrome.tabs.sendMessage(tabId, payload);
  for (let i = 0; i < 25; i++) {
    try {
      await sendOnce();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  console.warn("[Notch] open-shared-review: could not reach content script on tab", tabId);
}

function sendCloudFallback(msg, sendResponse) {
  if (!sendResponse) return;
  const t = msg?.type;
  if (t === "MF_SUPABASE_SESSION") {
    sendResponse({ configured: isSupabaseConfigured(), user: null });
    return;
  }
  if (t === "MF_AUTH_SIGN_IN" || t === "MF_AUTH_SIGN_UP") {
    sendResponse({ ok: false, error: "Cloud handler failed." });
    return;
  }
  if (t === "MF_AUTH_CHANGED") {
    sendResponse({ ok: false });
    return;
  }
  if (t === "MF_SUPABASE_SIGN_OUT") {
    sendResponse({ ok: true });
    return;
  }
  if (t === "MF_CLOUD_LOAD_CLIP") {
    sendResponse({ ok: false, record: null });
    return;
  }
  if (t === "MF_CLOUD_SAVE_CLIP") {
    sendResponse({ ok: false });
    return;
  }
  if (t === "MF_CLOUD_LIST_CLIPS") {
    sendResponse({ ok: false, items: [] });
    return;
  }
  if (t === "MF_CLOUD_UPDATE_THUMB") {
    sendResponse({ ok: false });
    return;
  }
  if (t === "MF_CLOUD_DELETE_CLIP") {
    sendResponse({ ok: false });
    return;
  }
  if (t === "MF_ENSURE_CLIP_REVIEW_ROW") {
    sendResponse({ ok: false, error: "fallback" });
    return;
  }
  if (t === "MF_JOIN_SHARED_REVIEW") {
    sendResponse({ ok: false, error: "fallback" });
    return;
  }
  if (t === "MF_COLLAB_LEAVE") {
    sendResponse({ ok: false });
    return;
  }
}

void restoreAuthMarker();

const SUPABASE_AUTH_STORAGE_KEY = "sb-notch-auth";

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const touched =
    Object.prototype.hasOwnProperty.call(changes, SUPABASE_AUTH_STORAGE_KEY) ||
    Object.prototype.hasOwnProperty.call(changes, `${SUPABASE_AUTH_STORAGE_KEY}-user`);
  if (!touched) return;
  invalidateSupabaseClient();
  void syncAuthMarkerFromChromeStorage();
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !isInjectableUrl(tab.url)) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" }).catch(() => {});
});

chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== "load-shared-review") return false;
  const uidRaw = msg.uid;
  const platformRaw = msg.platform;
  const clipRaw = msg.clip;
  if (
    uidRaw == null ||
    String(uidRaw).trim() === "" ||
    platformRaw == null ||
    String(platformRaw).trim() === "" ||
    clipRaw == null ||
    String(clipRaw).trim() === ""
  ) {
    sendResponse({ ok: false, error: "invalid_args" });
    return false;
  }
  const stored = {
    uid: String(uidRaw).trim(),
    platform: String(platformRaw).trim(),
    clip: String(clipRaw),
    receivedAt: Date.now(),
  };
  const internal = {
    action: "open-shared-review",
    uid: stored.uid,
    platform: stored.platform,
    clip: stored.clip,
  };
  void (async () => {
    try {
      await chrome.storage.local.set({ [NOTCH_SHARED_REVIEW_STORAGE_KEY]: stored });
      try {
        if (typeof chrome.action?.openPopup === "function") {
          await chrome.action.openPopup();
        }
      } catch {
        /* No default_popup in manifest — expected. Primary UI is the sidebar on the video tab. */
      }
      const tabId = await findOrOpenTabForSharedReview(stored.platform, stored.clip);
      if (tabId != null) {
        await dispatchOpenSharedReviewToTab(tabId, internal);
      }
      chrome.runtime.sendMessage(internal).catch(() => {});
      sendResponse({ ok: true, tabId: tabId ?? null });
    } catch (e) {
      console.error("[Notch] load-shared-review", e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "FETCH_VIMEO_OEMBED_THUMB" && msg.clipId) {
    const watchUrl = "https://vimeo.com/" + encodeURIComponent(String(msg.clipId));
    const api =
      "https://vimeo.com/api/oembed.json?url=" + encodeURIComponent(watchUrl) + "&width=640";
    fetch(api)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        const thumbnailUrl =
          j && typeof j.thumbnail_url === "string" && j.thumbnail_url.startsWith("http")
            ? j.thumbnail_url
            : null;
        sendResponse({ ok: !!thumbnailUrl, thumbnailUrl });
      })
      .catch(() => sendResponse({ ok: false, thumbnailUrl: null }));
    return true;
  }
  if (msg?.type === "FETCH_LOOM_OEMBED_THUMB" && msg.clipId) {
    const shareUrl =
      "https://www.loom.com/share/" + encodeURIComponent(String(msg.clipId).toLowerCase());
    const api =
      "https://www.loom.com/v1/oembed?format=json&url=" + encodeURIComponent(shareUrl);
    fetch(api)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        const thumbnailUrl =
          j && typeof j.thumbnail_url === "string" && j.thumbnail_url.startsWith("http")
            ? j.thumbnail_url
            : null;
        sendResponse({ ok: !!thumbnailUrl, thumbnailUrl });
      })
      .catch(() => sendResponse({ ok: false, thumbnailUrl: null }));
    return true;
  }

  if (msg?.type === "MF_SUPABASE_CONFIG") {
    sendResponse({
      ok: true,
      configured: isSupabaseConfigured(),
      url: SUPABASE_URL || "",
    });
    return false;
  }

  if (!CLOUD_TYPES.has(msg?.type)) return false;

  try {
    return handleRuntimeMessage(msg, sendResponse);
  } catch (e) {
    console.error("Notch: cloud handler", e);
    sendCloudFallback(msg, sendResponse);
    return false;
  }
});
