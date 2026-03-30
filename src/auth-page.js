import { createClient } from "@supabase/supabase-js";
import { isClientSafeSupabaseKey } from "./supabase-client-key.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const AUTH_STORAGE_KEY = "sb-notch-auth";

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
  const authFields = document.getElementById("nf-auth-fields");
  const tabSignIn = document.getElementById("nf-tab-sign-in");
  const tabSignUp = document.getElementById("nf-tab-sign-up");
  const signupOnly = document.getElementById("nf-signup-only");
  const emailEl = document.getElementById("nf-email");
  const passEl = document.getElementById("nf-password");
  const passConfirmEl = document.getElementById("nf-password-confirm");
  const signInBtn = document.getElementById("nf-sign-in");
  const signUpBtn = document.getElementById("nf-sign-up");
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
    },
  });

  function setAuthTab(mode) {
    const isSignUp = mode === "sign-up";
    tabSignIn.classList.toggle("nf-tab-active", !isSignUp);
    tabSignUp.classList.toggle("nf-tab-active", isSignUp);
    tabSignIn.setAttribute("aria-selected", String(!isSignUp));
    tabSignUp.setAttribute("aria-selected", String(isSignUp));
    if (authFields) {
      authFields.setAttribute("aria-labelledby", isSignUp ? "nf-tab-sign-up" : "nf-tab-sign-in");
    }
    if (signupOnly) signupOnly.hidden = !isSignUp;
    signInBtn.hidden = isSignUp;
    signUpBtn.hidden = !isSignUp;
    passEl.setAttribute("autocomplete", isSignUp ? "new-password" : "current-password");
  }

  tabSignIn.addEventListener("click", () => setAuthTab("sign-in"));
  tabSignUp.addEventListener("click", () => setAuthTab("sign-up"));

  async function refreshUi() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const signedIn = !!session?.user;
    if (signedOutWrap) signedOutWrap.hidden = signedIn;
    emailEl.disabled = signedIn;
    passEl.disabled = signedIn;
    if (passConfirmEl) passConfirmEl.disabled = signedIn;
    signOutBtn.hidden = !signedIn;
    if (signedIn) {
      showStatus(statusEl, "Signed in as " + (session.user.email || "user") + ". You can close this tab.", "ok");
    } else {
      setAuthTab("sign-in");
      showStatus(statusEl, "Sign in to sync your reviews across browsers.", "");
    }
  }

  signInBtn.addEventListener("click", async () => {
    const email = (emailEl.value || "").trim();
    const password = passEl.value || "";
    if (!email || !password) {
      showStatus(statusEl, "Enter email and password.", "err");
      return;
    }
    showStatus(statusEl, "Signing in…", "");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      showStatus(statusEl, error.message, "err");
      return;
    }
    try {
      await chrome.runtime.sendMessage({ type: "MF_AUTH_CHANGED" });
    } catch (_) {}
    await refreshUi();
  });

  signUpBtn.addEventListener("click", async () => {
    const email = (emailEl.value || "").trim();
    const password = passEl.value || "";
    if (!email || !password) {
      showStatus(statusEl, "Enter email and password.", "err");
      return;
    }
    if (password.length < 6) {
      showStatus(statusEl, "Password must be at least 6 characters.", "err");
      return;
    }
    const confirm = passConfirmEl?.value || "";
    if (password !== confirm) {
      showStatus(statusEl, "Passwords do not match.", "err");
      return;
    }
    showStatus(statusEl, "Creating account…", "");
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) {
      showStatus(statusEl, error.message, "err");
      return;
    }
    showStatus(
      statusEl,
      "Check your email to confirm (if confirmation is enabled in Supabase), then sign in.",
      "ok"
    );
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
