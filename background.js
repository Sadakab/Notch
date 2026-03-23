(function () {
  "use strict";

  function isInjectableUrl(url) {
    try {
      const u = new URL(url || "");
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

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
  });
})();
