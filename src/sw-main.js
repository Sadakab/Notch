import { isClientSafeSupabaseKey } from "./supabase-client-key.js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";
import {
  cleanupRealtimeForTab,
  handleRuntimeMessage,
  handoffSupabaseSession,
  invalidateSupabaseClient,
  restoreAuthMarker,
  syncAuthMarkerFromChromeStorage,
} from "./sw-cloud.js";

const CLOUD_TYPES = new Set([
  "MF_AUTH_OAUTH_GOOGLE",
  "MF_AUTH_MAGIC_LINK",
  "MF_AUTH_CHANGED",
  "MF_SUPABASE_SESSION",
  "MF_SUPABASE_GET_USER",
  "MF_SUPABASE_SET_PREFERENCES",
  "MF_SUPABASE_FETCH_PUBLIC_DISPLAY_NAMES",
  "MF_SUPABASE_SIGN_OUT",
  "MF_SUPABASE_CHANGE_EMAIL",
  "MF_SUPABASE_RESET_PASSWORD",
  "MF_SUPABASE_DELETE_USER",
  "MF_CLOUD_LOAD_CLIP",
  "MF_CLOUD_SAVE_CLIP",
  "MF_GUEST_CLOUD_LOAD_CLIP",
  "MF_GUEST_CLOUD_SAVE_CLIP",
  "MF_CLOUD_LIST_CLIPS",
  "MF_CLOUD_UPDATE_THUMB",
  "MF_CLOUD_DELETE_CLIP",
  "MF_CLOUD_SUBSCRIBE_CLIP_REACTIONS",
  "MF_CLOUD_UNSUBSCRIBE_CLIP_REACTIONS",
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

const GLOBAL_NOTCH_STATE_KEYS = {
  isVisible: "isVisible",
  activePanelView: "activePanelView",
};

function normalizeGlobalNotchState(raw) {
  const isVisible = raw?.isVisible !== false;
  const activePanelView = raw?.activePanelView === "settings" ? "settings" : "main";
  return { isVisible, activePanelView };
}

async function getGlobalNotchState() {
  const got = await chrome.storage.local.get([
    GLOBAL_NOTCH_STATE_KEYS.isVisible,
    GLOBAL_NOTCH_STATE_KEYS.activePanelView,
  ]);
  return normalizeGlobalNotchState(got);
}

async function setGlobalNotchStatePatch(patch) {
  const current = await getGlobalNotchState();
  const next = normalizeGlobalNotchState({ ...current, ...patch });
  await chrome.storage.local.set({
    [GLOBAL_NOTCH_STATE_KEYS.isVisible]: next.isVisible,
    [GLOBAL_NOTCH_STATE_KEYS.activePanelView]: next.activePanelView,
  });
  return next;
}

async function broadcastNotchStateUpdate(state) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) => {
      if (!tab?.id) return Promise.resolve();
      return chrome.tabs.sendMessage(tab.id, { type: "NOTCH_STATE_UPDATE", state }).catch(() => {});
    })
  );
}

const NOTCH_SHARED_REVIEW_STORAGE_KEY = "notch_shared_review";
const NOTCH_PENDING_SHARE_STORAGE_KEY = "notch_pending_share";

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

function appendNotchReviewSearchParam(urlStr) {
  try {
    const u = new URL(urlStr);
    u.searchParams.set("notch_review", "1");
    return u.toString();
  } catch {
    return urlStr;
  }
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
 * @param {{ revealSidebar?: boolean }} [opts] — popup “open video”: reveal sidebar in that tab.
 * @returns {Promise<number | null>} tab id
 */
async function findOrOpenTabForSharedReview(platform, clipId, opts) {
  const revealSidebar = opts?.revealSidebar === true;
  const patterns = tabUrlPatternsForSharedReview(platform, clipId);
  for (const pattern of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      const hit = tabs.find((t) => t.id != null && isInjectableUrl(t.url));
      if (hit) {
        await focusTab(hit);
        if (revealSidebar && hit.id != null) {
          try {
            await chrome.tabs.sendMessage(hit.id, { type: "NOTCH_REVEAL_SIDEBAR" });
          } catch {
            /* content script may not be injected yet */
          }
        }
        return hit.id;
      }
    } catch {
      /* ignore malformed pattern */
    }
  }
  let openUrl = buildWatchUrlForSharedReview(platform, clipId);
  if (!openUrl || !isInjectableUrl(openUrl)) return null;
  if (revealSidebar) {
    openUrl = appendNotchReviewSearchParam(openUrl);
  }
  const created = await chrome.tabs.create({ url: openUrl, active: true });
  return created?.id ?? null;
}

/** Deliver to content script (background cannot reach CS via runtime.sendMessage). */
/** @returns {Promise<boolean>} true if chrome.tabs.sendMessage succeeded */
async function dispatchOpenSharedReviewToTab(tabId, payload) {
  const sendOnce = () => chrome.tabs.sendMessage(tabId, payload);
  for (let i = 0; i < 25; i++) {
    try {
      await sendOnce();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

function sendCloudFallback(msg, sendResponse) {
  if (!sendResponse) return;
  const t = msg?.type;
  if (t === "MF_SUPABASE_SESSION") {
    sendResponse({ configured: isSupabaseConfigured(), user: null });
    return;
  }
  if (t === "MF_AUTH_OAUTH_GOOGLE" || t === "MF_AUTH_MAGIC_LINK") {
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
  if (t === "MF_SUPABASE_CHANGE_EMAIL" || t === "MF_SUPABASE_RESET_PASSWORD") {
    sendResponse({ ok: false, error: "Cloud handler failed." });
    return;
  }
  if (t === "MF_SUPABASE_DELETE_USER") {
    sendResponse({ ok: false, error: "Cloud handler failed." });
    return;
  }
  if (t === "MF_SUPABASE_FETCH_PUBLIC_DISPLAY_NAMES") {
    sendResponse({ ok: false, error: "Cloud handler failed.", names: {} });
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
  if (t === "MF_GUEST_CLOUD_LOAD_CLIP") {
    sendResponse({ ok: false, record: null });
    return;
  }
  if (t === "MF_GUEST_CLOUD_SAVE_CLIP") {
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
  if (t === "MF_CLOUD_SUBSCRIBE_CLIP_REACTIONS" || t === "MF_CLOUD_UNSUBSCRIBE_CLIP_REACTIONS") {
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

chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "NOTCH_STORE_PENDING_SHARE") {
    console.log("NOTCH_STORE_PENDING_SHARE received", {
      uid: msg?.uid,
      platform: msg?.platform,
      clip: msg?.clip,
    });
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
    const pending = {
      uid: String(uidRaw).trim(),
      platform: String(platformRaw).trim(),
      clip: String(clipRaw),
      receivedAt: Date.now(),
    };
    void chrome.storage.local
      .set({ [NOTCH_PENDING_SHARE_STORAGE_KEY]: pending })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg && typeof msg === "object" && msg.session) {
    void (async () => {
      try {
        const result = await handoffSupabaseSession(msg.session);
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
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
      console.log("[Notch debug] load-shared-review (external) received", {
        uid: stored.uid,
        platform: stored.platform,
        clip: stored.clip,
      });
      await chrome.storage.local.set({ [NOTCH_SHARED_REVIEW_STORAGE_KEY]: stored });
      try {
        if (typeof chrome.action?.openPopup === "function") {
          await chrome.action.openPopup();
        }
      } catch {
        /* openPopup may fail without a user gesture or if the popup cannot be shown. */
      }
      const tabId = await findOrOpenTabForSharedReview(stored.platform, stored.clip);
      console.log("[Notch debug] load-shared-review (external) tab lookup", {
        tabId: tabId ?? null,
        foundOrOpened: tabId != null,
      });
      if (tabId != null) {
        const delivered = await dispatchOpenSharedReviewToTab(tabId, internal);
        if (delivered) {
          console.log(
            "[Notch debug] load-shared-review (external) dispatchOpenSharedReviewToTab finished",
            { tabId }
          );
        } else {
          console.log(
            "[Notch debug] load-shared-review (external) dispatchOpenSharedReviewToTab failed after retries",
            { tabId }
          );
        }
      } else {
        console.log(
          "[Notch debug] load-shared-review (external) no injectable tab; skipped tab dispatch"
        );
      }
      try {
        await chrome.runtime.sendMessage(internal);
        console.log("[Notch debug] load-shared-review (external) chrome.runtime.sendMessage OK");
      } catch (e) {
        console.log(
          "[Notch debug] load-shared-review (external) chrome.runtime.sendMessage failed",
          String(e?.message || e)
        );
      }
      sendResponse({ ok: true, tabId: tabId ?? null });
    } catch (e) {
      console.log(
        "[Notch debug] load-shared-review (external) handler error",
        String(e?.message || e)
      );
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === "load-shared-review") {
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
    const internal = {
      action: "open-shared-review",
      uid: String(uidRaw).trim(),
      platform: String(platformRaw).trim(),
      clip: String(clipRaw),
    };
    const senderTabId = sender?.tab?.id;
    if (senderTabId == null) {
      console.log("[Notch debug] load-shared-review (internal) missing sender.tab.id");
      sendResponse({ ok: false, error: "no_sender_tab" });
      return false;
    }
    void (async () => {
      console.log("[Notch debug] load-shared-review (internal) received", {
        uid: internal.uid,
        platform: internal.platform,
        clip: internal.clip,
        senderTabId,
      });
      console.log(
        "[Notch debug] load-shared-review (internal) sending open-shared-review via chrome.tabs.sendMessage",
        { senderTabId }
      );
      const delivered = await dispatchOpenSharedReviewToTab(senderTabId, internal);
      if (delivered) {
        console.log("[Notch debug] load-shared-review (internal) chrome.tabs.sendMessage OK");
        sendResponse({ ok: true });
      } else {
        console.log(
          "[Notch debug] load-shared-review (internal) chrome.tabs.sendMessage failed after retries"
        );
        sendResponse({ ok: false, error: "tab_message_failed" });
      }
    })();
    return true;
  }

  if (msg?.type === "NOTCH_OPEN_VIDEO_TAB") {
    const platform = msg.platform;
    const clipId = msg.clipId;
    if (platform == null || String(platform).trim() === "" || clipId == null || String(clipId) === "") {
      sendResponse({ ok: false, error: "invalid_args" });
      return false;
    }
    void (async () => {
      try {
        const tabId = await findOrOpenTabForSharedReview(String(platform).trim(), String(clipId), {
          revealSidebar: true,
        });
        sendResponse({ ok: true, tabId: tabId ?? null });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "MF_OPEN_TAB") {
    const url = String(msg.url || "").trim();
    if (!url || !isInjectableUrl(url)) {
      sendResponse({ ok: false, error: "invalid_url" });
      return false;
    }
    void chrome.tabs
      .create({ url, active: true })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === "NOTCH_SET_GLOBAL_STATE") {
    void (async () => {
      try {
        const next = await setGlobalNotchStatePatch(msg.patch || {});
        await broadcastNotchStateUpdate(next);
        sendResponse({ ok: true, state: next });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

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

  /** Google Drive screengrab: crop visible tab to the embed iframe (cross-origin player). */
  if (msg?.type === "MF_CAPTURE_VISIBLE_TAB") {
    const windowId = sender.tab?.windowId;
    if (windowId == null) {
      sendResponse({ ok: false, error: "no_tab" });
      return false;
    }
    chrome.tabs
      .captureVisibleTab(windowId, { format: "png" })
      .then((dataUrl) => {
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
          sendResponse({ ok: true, dataUrl });
        } else {
          sendResponse({ ok: false, error: "bad_capture" });
        }
      })
      .catch((e) => {
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
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

  /** Content script refreshed `notch_popup_reviews`; popup listens via chrome.storage.onChanged. */
  if (msg?.type === "NOTCH_POPUP_REVIEWS_UPDATED") {
    sendResponse({ ok: true });
    return false;
  }

  if (!CLOUD_TYPES.has(msg?.type)) return false;

  try {
    return handleRuntimeMessage(msg, sendResponse, sender);
  } catch (e) {
    sendCloudFallback(msg, sendResponse);
    return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void cleanupRealtimeForTab(tabId);
});
