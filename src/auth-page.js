import { createClient } from "@supabase/supabase-js";
import { isClientSafeSupabaseKey } from "./supabase-client-key.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const AUTH_STORAGE_KEY = "sb-notch-auth";
const AUTH_CONFIRM_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:3000/auth/confirm.html"
    : "https://notch.video/auth/confirm.html";
const MAGIC_LINK_COOLDOWN_SECONDS = 60;

function createChromeStorageAdapter() {
  return {
    getItem: async (key) => {
      const o = await chrome.storage.local.get(key);
      return o[key] ?? null;
    },
    setItem: async (key, value) => {
      await chrome.storage.local.set({ [key]: value });
    },
    removeItem: async (key) => {
      await chrome.storage.local.remove(key);
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
  let magicLinkCooldownUntil = 0;
  let magicLinkCooldownTimer = null;

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
    magicLinkBtn.disabled = !!busy || magicLinkCooldownUntil > Date.now();
  }

  function clearMagicLinkCooldownTimer() {
    if (magicLinkCooldownTimer) {
      window.clearInterval(magicLinkCooldownTimer);
      magicLinkCooldownTimer = null;
    }
  }

  function updateMagicLinkButtonLabel() {
    const remainingMs = magicLinkCooldownUntil - Date.now();
    if (remainingMs <= 0) {
      magicLinkBtn.textContent = "Send magic link";
      magicLinkBtn.disabled = false;
      clearMagicLinkCooldownTimer();
      return;
    }

    const remainingSeconds = Math.ceil(remainingMs / 1000);
    magicLinkBtn.textContent = `Send magic link (${remainingSeconds}s)`;
    magicLinkBtn.disabled = true;
  }

  function startMagicLinkCooldown() {
    magicLinkCooldownUntil = Date.now() + MAGIC_LINK_COOLDOWN_SECONDS * 1000;
    updateMagicLinkButtonLabel();
    clearMagicLinkCooldownTimer();
    magicLinkCooldownTimer = window.setInterval(updateMagicLinkButtonLabel, 1000);
  }

  async function refreshUi() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const signedIn = !!session?.user;
    if (signedOutWrap) signedOutWrap.hidden = signedIn;
    emailEl.disabled = signedIn;
    googleBtn.disabled = signedIn;
    magicLinkBtn.disabled = signedIn || magicLinkCooldownUntil > Date.now();
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
        shouldCreateUser: true,
        emailRedirectTo: AUTH_CONFIRM_URL,
      },
    });
    if (error) {
      showStatus(statusEl, error.message, "err");
      setSignedOutBusy(false);
      return;
    }
    showStatus(statusEl, "Check your email for a login link", "ok");
    startMagicLinkCooldown();
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
