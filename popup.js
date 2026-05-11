(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/popup.js
  var require_popup = __commonJS({
    "src/popup.js"() {
      (function() {
        const HOSTED_ORIGIN = "https://notch.video";
        const frame = document.getElementById("np-frame");
        let frameReady = false;
        frame.addEventListener("load", () => {
          frameReady = true;
          frame.contentWindow.postMessage(
            { type: "NOTCH_INIT", extensionId: chrome.runtime.id },
            HOSTED_ORIGIN
          );
        });
        chrome.storage.onChanged.addListener((changes, area) => {
          if (!frameReady) return;
          frame.contentWindow.postMessage({ type: "NOTCH_STORAGE_CHANGED", changes, area }, HOSTED_ORIGIN);
        });
        window.addEventListener("message", async (e) => {
          if (e.origin !== HOSTED_ORIGIN) return;
          const { id, type, payload } = e.data || {};
          if (!type) return;
          const reply = (result) => frame.contentWindow.postMessage({ id, result }, HOSTED_ORIGIN);
          switch (type) {
            case "STORAGE_LOCAL_GET":
              reply(await chrome.storage.local.get(payload.keys));
              break;
            case "STORAGE_LOCAL_SET":
              await chrome.storage.local.set(payload.obj);
              reply({ ok: true });
              break;
            case "STORAGE_LOCAL_REMOVE":
              await chrome.storage.local.remove(payload.keys);
              reply({ ok: true });
              break;
            case "STORAGE_SYNC_GET":
              try {
                reply(await chrome.storage.sync.get(payload.defaults));
              } catch {
                reply(payload.defaults || {});
              }
              break;
            case "STORAGE_SYNC_SET":
              try {
                await chrome.storage.sync.set(payload.obj);
              } catch {
              }
              reply({ ok: true });
              break;
            case "TABS_GET_ACTIVE":
              try {
                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                reply({ tab: tabs[0] || null });
              } catch {
                reply({ tab: null });
              }
              break;
            case "TABS_SEND_MESSAGE":
              try {
                const response = await chrome.tabs.sendMessage(payload.tabId, payload.message);
                reply({ ok: true, response });
              } catch {
                reply({ ok: false, response: null });
              }
              break;
            case "POPUP_CLOSE":
              window.close();
              break;
          }
        });
      })();
    }
  });
  require_popup();
})();
