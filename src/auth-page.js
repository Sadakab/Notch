import { createClient } from "@supabase/supabase-js";
import { isClientSafeSupabaseKey } from "./supabase-client-key.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const AUTH_STORAGE_KEY = "sb-notch-auth";
const AUTH_CONFIRM_URL = "https://notch.so/auth/confirm";

function createChromeStorageAdapter() {
  return {
    getItem: async (key) => {
      const o = await chrome.storage.sync.get(key);
      return o[key] ?? null;
    },
    setItem: async (key, value) => {
      await chrome.storage.sync.set({ [key]: value });
    },
    removeItem: async (key) => {
      await chrome.storage.sync.remove(key);
    },
  };
}

function showStatus(el, text, kind) {
  el.textContent = text;
  el.className = "nf-auth-status" + (kind ? " nf-" + kind : "");
}

function main() {
  const statusEl = document.getElementById("nf-status");
  const signedOutWrap = document.getElementById("nf-signed-out-wrap");
  const emailEl = document.getElementById("nf-email");
  const googleBtn = document.getElementById("nf-google-sign-in");
  const magicLinkBtn = document.getElementById("nf-send-magic-link");
  const signOutBtn = document.getElementById("nf-sign-out");
  const configWarn = document.getElementById("nf-config-warn");

  if (!SUPABASE_ANON_KEY || !SUPABASE_URL || !isClientSafeSupabaseKey(SUPABASE_ANON_KEY)) {
    configWarn.hidden = false;
    showStatus(
      statusEl,
      "Add your publishable or anon API key (not sb_secret_) in src/supabase-config.js, run npm run build, reload the extension.",
      "err"
    );
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: createChromeStorageAdapter(),
      storageKey: AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  function setSignedOutBusy(busy) {
    emailEl.disabled = !!busy;
    googleBtn.disabled = !!busy;
    magicLinkBtn.disabled = !!busy;
  }

  async function refreshUi() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const signedIn = !!session?.user;
    if (signedOutWrap) signedOutWrap.hidden = signedIn;
    emailEl.disabled = signedIn;
    googleBtn.disabled = signedIn;
    magicLinkBtn.disabled = signedIn;
    signOutBtn.hidden = !signedIn;
    if (signedIn) {
      showStatus(statusEl, "Signed in as " + (session.user.email || "user") + ". You can close this tab.", "ok");
    } else {
      showStatus(statusEl, "Sign in to sync your reviews across browsers.", "");
    }
  }

  googleBtn.addEventListener("click", async () => {
    setSignedOutBusy(true);
    showStatus(statusEl, "Opening Google sign-in…", "");
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: AUTH_CONFIRM_URL,
        skipBrowserRedirect: true,
      },
    });
    if (error) {
      showStatus(statusEl, error.message, "err");
      setSignedOutBusy(false);
      return;
    }
    if (!data?.url) {
      showStatus(statusEl, "Could not start Google sign-in.", "err");
      setSignedOutBusy(false);
      return;
    }
    window.open(data.url, "_blank", "noopener,noreferrer");
    showStatus(statusEl, "Continue in the opened Google sign-in tab.", "ok");
    setSignedOutBusy(false);
  });

  magicLinkBtn.addEventListener("click", async () => {
    const email = (emailEl.value || "").trim();
    if (!email) {
      showStatus(statusEl, "Enter your email.", "err");
      return;
    }
    setSignedOutBusy(true);
    showStatus(statusEl, "Sending magic link…", "");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: AUTH_CONFIRM_URL,
      },
    });
    if (error) {
      showStatus(statusEl, error.message, "err");
      setSignedOutBusy(false);
      return;
    }
    showStatus(statusEl, "Check your email for a login link", "ok");
    setSignedOutBusy(false);
  });

  signOutBtn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    try {
      await chrome.runtime.sendMessage({ type: "MF_AUTH_CHANGED" });
    } catch (_) {}
    await refreshUi();
  });

  void refreshUi();
}

document.addEventListener("DOMContentLoaded", main);
