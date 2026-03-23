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
