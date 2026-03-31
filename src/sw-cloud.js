import { createClient } from "@supabase/supabase-js";
import { isClientSafeSupabaseKey } from "./supabase-client-key.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const AUTH_STORAGE_KEY = "sb-notch-auth";
const AUTH_STATE_KEY = "markframe_auth_state";
const AUTH_CONFIRM_URL = "https://notch.so/auth/confirm";

const CLIP_PLATFORMS = ["youtube", "vimeo", "loom", "googledrive", "dropbox"];

/** Service worker diagnostics (extension page console: inspect service worker). Set false to silence. */
const NOTCH_DIAG = true;
function notchSwLog(msg, detail) {
  if (!NOTCH_DIAG) return;
  if (detail !== undefined) {
    const extra =
      detail && typeof detail === "object"
        ? JSON.stringify(detail)
        : String(detail);
    console.log("[Notch SW]", msg, extra);
  } else {
    console.log("[Notch SW]", msg);
  }
}

function planFromSupabaseUser(u) {
  if (!u) return "free";
  const raw =
    u.app_metadata?.plan ||
    u.user_metadata?.plan ||
    u.app_metadata?.tier ||
    u.user_metadata?.tier;
  return String(raw || "").trim().toLowerCase() === "pro" ? "pro" : "free";
}

function dropboxHostnameOk(h) {
  return h === "dropbox.com" || h === "www.dropbox.com" || h === "m.dropbox.com";
}

/**
 * Parse a Dropbox clip id (path, path?query, or full https URL) for normalization.
 * @returns {URL | null}
 */
function parseDropboxClipIdToUrl(clipId) {
  if (!clipId || typeof clipId !== "string") return null;
  const s = clipId.trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (!dropboxHostnameOk(u.hostname)) return null;
      return u;
    }
    const pathAndQuery = s.startsWith("/") ? s : "/" + s.replace(/^\/+/, "");
    return new URL("https://www.dropbox.com" + pathAndQuery);
  } catch {
    return null;
  }
}

/** Guests need `rlkey` on /scl/fi/… links; omit volatile params (`e`, `st`, …). */
function dropboxStableQueryString(searchParams) {
  if (!searchParams || typeof searchParams.get !== "function") return "";
  const rlkey = searchParams.get("rlkey");
  const dl = searchParams.get("dl");
  const parts = [];
  if (rlkey) parts.push("rlkey=" + encodeURIComponent(rlkey));
  if (dl != null && dl !== "") parts.push("dl=" + encodeURIComponent(dl));
  return parts.length ? "?" + parts.join("&") : "";
}

function dropboxPathnameOnlyFromClipId(clipId) {
  const u = parseDropboxClipIdToUrl(clipId);
  if (u && dropboxHostnameOk(u.hostname)) {
    return u.pathname || "";
  }
  const raw = String(clipId || "");
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * Stable clip_id for clip_reviews: pathname + ?rlkey=… (& dl if present).
 * Matches legacy path-only rows via load/dedupe prefix logic.
 */
function normalizeDropboxClipIdForDb(platform, clipId) {
  if (platform !== "dropbox" || typeof clipId !== "string" || !clipId) return clipId;
  const u = parseDropboxClipIdToUrl(clipId);
  if (!u || !dropboxHostnameOk(u.hostname)) {
    const q = clipId.indexOf("?");
    return q === -1 ? clipId : clipId.slice(0, q);
  }
  const path = u.pathname || "";
  if (!path) return clipId;
  return path + dropboxStableQueryString(u.searchParams);
}

/** Prefer message host id (collab) when non-empty after stringify — avoids missing saves if UI passes a non-string UUID. */
function rowUserIdFromHostMessage(msgHost, sessionUserId) {
  if (msgHost == null || msgHost === "") return sessionUserId;
  const s = String(msgHost).trim();
  return s.length > 0 ? s : sessionUserId;
}

function normalizedHostUserId(msgHost) {
  if (msgHost == null || msgHost === "") return "";
  return String(msgHost).trim();
}

/** Readable PostgREST / Postgres error for extension logs (avoids "[object Object]"). */
function formatSupabaseError(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  const msg = err.message || err.error_description || "";
  const code = err.code || "";
  const details = err.details || "";
  const hint = err.hint || "";
  const parts = [msg, code ? `code=${code}` : "", details ? `details=${details}` : "", hint ? `hint=${hint}` : ""].filter(
    Boolean
  );
  return parts.length ? parts.join(" | ") : JSON.stringify(err);
}

/** Supabase text / nullable columns — reject odd types from page metadata. */
function cloudOptionalTextField(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") return v;
  return String(v);
}

/** Escape for PostgreSQL LIKE; append % to match legacy rows saved as path?query… */
function sqlLikePrefixFromPath(pathPrefix) {
  if (pathPrefix == null || typeof pathPrefix !== "string" || pathPrefix.length === 0) return null;
  return pathPrefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
/**
 * @param {string} clipOwnerUserId Row owner in clip_reviews (session user or collab host).
 */
async function loadClipReviewRow(client, platform, clipId, clipOwnerUserId) {
  if (!clipOwnerUserId) {
    return { data: null, error: { message: "missing clip owner id" } };
  }
  if (platform === "dropbox") {
    const normalized = normalizeDropboxClipIdForDb(platform, clipId);
    const pathOnly = dropboxPathnameOnlyFromClipId(normalized);

    const rExact = await client
      .from("clip_reviews")
      .select("*")
      .eq("platform", "dropbox")
      .eq("user_id", clipOwnerUserId)
      .eq("clip_id", normalized)
      .maybeSingle();
    if (rExact.error) return { data: null, error: rExact.error };
    if (rExact.data) return { data: rExact.data, error: null };

    const rLegacyPath = await client
      .from("clip_reviews")
      .select("*")
      .eq("platform", "dropbox")
      .eq("user_id", clipOwnerUserId)
      .eq("clip_id", pathOnly)
      .maybeSingle();
    if (rLegacyPath.error) return { data: null, error: rLegacyPath.error };
    if (rLegacyPath.data) return { data: rLegacyPath.data, error: null };

    const pat = sqlLikePrefixFromPath(pathOnly);
    if (!pat) return { data: null, error: null };
    const r2 = await client
      .from("clip_reviews")
      .select("*")
      .eq("platform", "dropbox")
      .eq("user_id", clipOwnerUserId)
      .like("clip_id", pat)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (r2.error) return { data: null, error: r2.error };
    const row = r2.data?.[0] ?? null;
    if (row) {
      notchSwLog("MF_CLOUD_LOAD_CLIP dropbox legacy prefix match", {
        requested: String(clipId).slice(0, 80),
        normalized: String(normalized).slice(0, 80),
        dbClipIdPrefix: String(row.clip_id).slice(0, 80),
      });
    }
    return { data: row, error: null };
  }
  const r = await client
    .from("clip_reviews")
    .select("*")
    .eq("platform", platform)
    .eq("user_id", clipOwnerUserId)
    .eq("clip_id", clipId)
    .maybeSingle();
  return { data: r.data ?? null, error: r.error };
}

function clipStorageKey(platform, clipId) {
  return "markframe_clip_" + platform + "_" + encodeURIComponent(clipId);
}

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

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let supabase = null;

/** Drop cached client so the next use reads the latest session from chrome.storage (e.g. after sign-in on auth.html). */
export function invalidateSupabaseClient() {
  supabase = null;
}

/**
 * Updates markframe_auth_state from the raw Supabase auth payload in storage.
 * Used when auth is written from another extension context (auth tab) that does not share the SW client.
 */
export async function syncAuthMarkerFromChromeStorage() {
  const userKey = `${AUTH_STORAGE_KEY}-user`;
  const data = await chrome.storage.local.get([AUTH_STORAGE_KEY, userKey]);
  const main = data[AUTH_STORAGE_KEY];
  if (main == null || main === "") {
    await chrome.storage.local.remove(AUTH_STATE_KEY);
    return;
  }
  let session = null;
  if (typeof main === "string") {
    try {
      session = JSON.parse(main);
    } catch {
      await chrome.storage.local.remove(AUTH_STATE_KEY);
      return;
    }
  } else if (typeof main === "object") {
    session = main;
  } else {
    await chrome.storage.local.remove(AUTH_STATE_KEY);
    return;
  }
  let user = session?.user ?? null;
  const userBlob = data[userKey];
  if ((!user || !user.email) && userBlob != null) {
    const parsed =
      typeof userBlob === "string"
        ? (() => {
            try {
              return JSON.parse(userBlob);
            } catch {
              return null;
            }
          })()
        : userBlob;
    if (parsed?.user) user = parsed.user;
  }
  const email = user?.email;
  if (email) {
    await chrome.storage.local.set({
      [AUTH_STATE_KEY]: { email: String(email), at: Date.now() },
    });
  } else {
    await chrome.storage.local.remove(AUTH_STATE_KEY);
  }
}

function getSupabase() {
  if (!SUPABASE_ANON_KEY || !SUPABASE_URL || !isClientSafeSupabaseKey(SUPABASE_ANON_KEY)) return null;
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: createChromeStorageAdapter(),
        storageKey: AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        // MV3 service workers are not a normal document context; avoid Web Locks / SW quirks.
        lock: async (_name, _acquireTimeout, fn) => await fn(),
      },
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      void (async () => {
        try {
          await syncAuthStateMarker(session);
        } catch (e) {
          console.warn("Notch auth state marker", e?.message || e);
        }
      })();
    });
  }
  return supabase;
}

async function syncAuthStateMarker(session) {
  if (session?.user?.email) {
    await chrome.storage.local.set({
      [AUTH_STATE_KEY]: { email: session.user.email, at: Date.now() },
    });
  } else {
    await chrome.storage.local.remove(AUTH_STATE_KEY);
  }
}

async function clearStoredSupabaseSession() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k === AUTH_STORAGE_KEY || k.startsWith(`${AUTH_STORAGE_KEY}-`));
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }
  await chrome.storage.local.remove(AUTH_STATE_KEY);
}

function isUnauthorizedError(err) {
  if (!err) return false;
  const status = Number(err?.status || err?.statusCode || 0);
  if (status === 401) return true;
  const code = String(err?.code || "").toUpperCase();
  if (code === "PGRST301" || code === "401") return true;
  const message = String(err?.message || err?.error_description || "").toLowerCase();
  return (
    message.includes("jwt") &&
    (message.includes("expired") || message.includes("invalid") || message.includes("malformed"))
  );
}

async function clearAuthSessionAndClient() {
  await clearStoredSupabaseSession();
  invalidateSupabaseClient();
}

/** Safe in MV3 SW: never destructure `data.session` (missing `data` throws). */
async function getSessionSafe(client) {
  try {
    const result = await client.auth.getSession();
    const err = result?.error ?? null;
    const session = result?.data?.session ?? null;
    if (err) {
      if (isUnauthorizedError(err)) {
        await clearAuthSessionAndClient();
      }
      console.warn("Notch getSession", err.message ?? err);
    }
    return { session, error: err };
  } catch (e) {
    console.warn("Notch getSession", e?.message || e);
    if (isUnauthorizedError(e)) {
      await clearAuthSessionAndClient();
    }
    return { session: null, error: e };
  }
}

export async function handoffSupabaseSession(sessionPayload) {
  const client = getSupabase();
  if (!client) return { ok: false, error: "Supabase is not configured." };
  const accessToken = String(sessionPayload?.access_token || "").trim();
  const refreshToken = String(sessionPayload?.refresh_token || "").trim();
  if (!accessToken || !refreshToken) {
    return { ok: false, error: "invalid_session_payload" };
  }
  const { data, error } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) {
    return { ok: false, error: error.message || "set_session_failed" };
  }
  await syncAuthStateMarker(data?.session ?? null);
  await syncAuthMarkerFromChromeStorage();
  return {
    ok: true,
    email: data?.session?.user?.email ?? null,
  };
}

/** Normalize jsonb / API quirks so the panel always gets a real array. */
function commentsFromDb(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowToPayload(row) {
  return {
    comments: commentsFromDb(row.comments),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    title: row.title ?? null,
    thumbnailUrl: row.thumbnail_url ?? null,
    platform: row.platform,
    clipId: row.clip_id,
  };
}

function defaultThumbForPlatform(platform, clipId) {
  if (platform === "youtube" && clipId) {
    return "https://i.ytimg.com/vi/" + encodeURIComponent(clipId) + "/hqdefault.jpg";
  }
  if (platform === "googledrive" && clipId) {
    return "https://drive.google.com/thumbnail?id=" + encodeURIComponent(clipId) + "&sz=w320";
  }
  return "";
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
  } catch {
    return "https://www.dropbox.com/";
  }
}

function openUrlForClip(platform, clipId) {
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
    return buildDropboxOpenUrl(clipId);
  }
  return "";
}

function rowToDashboardItem(row) {
  const platform = row.platform;
  const clipId = row.clip_id;
  const v = rowToPayload(row);
  const comments = v.comments;
  const storageKey = clipStorageKey(platform, clipId);
  let thumb = v.thumbnailUrl || null;
  if (platform === "youtube" && thumb) {
    const m = thumb.match(/\/vi\/([^/?#]+)\//);
    const thumbVid = m ? m[1] : null;
    if (thumbVid && thumbVid !== clipId) thumb = null;
  }
  return {
    storageKey,
    platform,
    clipId,
    title: v.title && String(v.title).trim() ? String(v.title).trim() : clipId || "Video",
    thumbnailUrl: thumb || defaultThumbForPlatform(platform, clipId) || "",
    commentCount: comments.length,
    updatedAt: v.updatedAt || 0,
    openUrl: openUrlForClip(platform, clipId),
    reviewOwnerUserId: row.user_id ?? null,
  };
}

/**
 * @returns {boolean} true if sendResponse will be called asynchronously
 */
export function handleRuntimeMessage(msg, sendResponse) {
  if (msg?.type === "MF_AUTH_OAUTH_GOOGLE") {
    void (async () => {
      try {
        const client = getSupabase();
        if (!client) {
          sendResponse({ ok: false, error: "Supabase is not configured." });
          return;
        }
        const { data, error } = await client.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: AUTH_CONFIRM_URL,
            skipBrowserRedirect: true,
          },
        });
        if (error) {
          sendResponse({ ok: false, error: error.message });
          return;
        }
        const url = String(data?.url || "");
        if (!url) {
          sendResponse({ ok: false, error: "Could not start Google sign-in." });
          return;
        }
        await chrome.tabs.create({ url, active: true });
        sendResponse({ ok: true });
      } catch (e) {
        console.error("Notch MF_AUTH_OAUTH_GOOGLE", e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "MF_AUTH_MAGIC_LINK") {
    const email = String(msg.email || "").trim();
    if (!email) {
      sendResponse({ ok: false, error: "Enter your email." });
      return false;
    }
    void (async () => {
      try {
        const client = getSupabase();
        if (!client) {
          sendResponse({ ok: false, error: "Supabase is not configured." });
          return;
        }
        const { error } = await client.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: AUTH_CONFIRM_URL,
          },
        });
        if (error) {
          sendResponse({ ok: false, error: error.message });
          return;
        }
        sendResponse({ ok: true, message: "Check your email for a login link" });
      } catch (e) {
        console.error("Notch MF_AUTH_MAGIC_LINK", e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "MF_AUTH_CHANGED") {
    invalidateSupabaseClient();
    void (async () => {
      try {
        await syncAuthMarkerFromChromeStorage();
        const client = getSupabase();
        if (!client) {
          sendResponse({ ok: false });
          return;
        }
        const { session, error } = await getSessionSafe(client);
        if (error && !session) {
          sendResponse({ ok: false });
          return;
        }
        try {
          await syncAuthStateMarker(session);
        } catch (e) {
          console.warn("Notch MF_AUTH_CHANGED marker", e?.message || e);
        }
        sendResponse({ ok: true, email: session?.user?.email ?? null });
      } catch (e) {
        console.error("Notch MF_AUTH_CHANGED", e);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg?.type === "MF_SUPABASE_SESSION") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ configured: false, user: null });
      return false;
    }
    void getSessionSafe(client).then(({ session, error }) => {
      if (error && !session) {
        sendResponse({
          configured: true,
          user: null,
          error: String(error?.message ?? error ?? ""),
        });
        return;
      }
      const u = session?.user;
      const plan = planFromSupabaseUser(u);
      sendResponse({
        configured: true,
        user: u ? { id: u.id, email: u.email, plan } : null,
      });
    });
    return true;
  }

  if (msg?.type === "MF_SUPABASE_SIGN_OUT") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ ok: true });
      return false;
    }
    client.auth.signOut().then(async () => {
      invalidateSupabaseClient();
      await syncAuthMarkerFromChromeStorage();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "MF_SUPABASE_CHANGE_EMAIL") {
    const client = getSupabase();
    const email = String(msg.email || "").trim();
    if (!client || !email) {
      sendResponse({ ok: false, error: "invalid_args" });
      return false;
    }
    void client.auth.updateUser({ email }).then(({ error }) => {
      if (error) {
        sendResponse({ ok: false, error: error.message || "Could not change email." });
        return;
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "MF_SUPABASE_RESET_PASSWORD") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ ok: false, error: "not_configured" });
      return false;
    }
    void getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      const email = session?.user?.email ? String(session.user.email).trim() : "";
      if (sessErr || !email) {
        sendResponse({ ok: false, error: "not_authenticated" });
        return;
      }
      const { error } = await client.auth.resetPasswordForEmail(email);
      if (error) {
        sendResponse({ ok: false, error: error.message || "Could not send reset email." });
        return;
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "MF_SUPABASE_DELETE_USER") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ ok: false, error: "not_configured" });
      return false;
    }
    void getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      const accessToken = session?.access_token ? String(session.access_token) : "";
      if (sessErr || !accessToken) {
        sendResponse({ ok: false, error: "not_authenticated" });
        return;
      }
      try {
        const resp = await fetch(String(SUPABASE_URL).replace(/\/+$/, "") + "/auth/v1/user", {
          method: "DELETE",
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ should_soft_delete: false }),
        });
        if (!resp.ok) {
          sendResponse({ ok: false, error: "Delete account failed." });
          return;
        }
        await client.auth.signOut();
        invalidateSupabaseClient();
        await syncAuthMarkerFromChromeStorage();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    });
    return true;
  }

  if (msg?.type === "MF_CLOUD_LOAD_CLIP") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    notchSwLog("MF_CLOUD_LOAD_CLIP request", { platform, clipId, hasClient: !!client });
    if (!client || !platform || !clipId) {
      notchSwLog("MF_CLOUD_LOAD_CLIP abort: missing client, platform, or clipId");
      sendResponse({ ok: false, record: null });
      return false;
    }
    getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      const user = session?.user;
      notchSwLog("MF_CLOUD_LOAD_CLIP session", {
        sessErr: sessErr?.message ?? null,
        hasUser: !!user,
        userId: user?.id ? String(user.id).slice(0, 8) + "…" : null,
      });
      if (sessErr || !user) {
        sendResponse({ ok: false, record: null });
        return;
      }
      try {
        const clipOwner = rowUserIdFromHostMessage(msg.hostUserId, user.id);
        const { data, error } = await loadClipReviewRow(client, platform, clipId, clipOwner);
        if (error) {
          const errLine = formatSupabaseError(error);
          console.error("Notch cloud load", errLine, error);
          notchSwLog("MF_CLOUD_LOAD_CLIP query error", {
            code: error.code,
            message: error.message,
            formatted: errLine,
            details: error.details,
          });
          sendResponse({ ok: false, record: null });
          return;
        }
        const rawComments = data?.comments;
        const cc = Array.isArray(rawComments)
          ? rawComments.length
          : rawComments == null
            ? "null"
            : typeof rawComments;
        notchSwLog("MF_CLOUD_LOAD_CLIP result", {
          rowFound: !!data,
          dbClipId: data?.clip_id ?? null,
          dbPlatform: data?.platform ?? null,
          commentsType: cc,
        });
        const record = data ? rowToPayload(data) : null;
        notchSwLog("MF_CLOUD_LOAD_CLIP payload", {
          recordNull: record == null,
          payloadCommentCount: record?.comments?.length ?? "n/a",
        });
        sendResponse({ ok: true, record });
      } catch (e) {
        console.error("Notch cloud load", e);
        sendResponse({ ok: false, record: null });
      }
    });
    return true;
  }

  if (msg?.type === "MF_CLOUD_SAVE_CLIP") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    const comments = msg.comments;
    notchSwLog("MF_CLOUD_SAVE_CLIP request", {
      platform,
      clipId,
      hasClient: !!client,
      commentsIsArray: Array.isArray(comments),
      commentCount: Array.isArray(comments) ? comments.length : "n/a",
      collabTargetHost: msg.hostUserId != null && String(msg.hostUserId).trim() !== "",
    });
    if (!client || !platform || !clipId || !Array.isArray(comments)) {
      notchSwLog("MF_CLOUD_SAVE_CLIP abort: bad args");
      sendResponse({ ok: false, error: "invalid_args" });
      return false;
    }
    getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      const user = session?.user;
      if (sessErr || !user) {
        sendResponse({ ok: false, error: "not_authenticated" });
        return;
      }
      const clipIdDb = normalizeDropboxClipIdForDb(platform, clipId);
      const hostUserId = normalizedHostUserId(msg.hostUserId);
      const rowUserId = rowUserIdFromHostMessage(hostUserId, user.id);
      const isCollaboratorWrite = rowUserId !== user.id;
      let commentsPayload = comments;
      try {
        commentsPayload = JSON.parse(JSON.stringify(comments));
      } catch {
        /* use raw */
      }
      const row = {
        user_id: rowUserId,
        platform,
        clip_id: clipIdDb,
        comments: commentsPayload,
        title: cloudOptionalTextField(msg.title),
        thumbnail_url: cloudOptionalTextField(msg.thumbnailUrl),
        updated_at: new Date().toISOString(),
      };
      try {
        if (!isCollaboratorWrite) {
          const { error } = await client.from("clip_reviews").upsert(row, { onConflict: "user_id,platform,clip_id" });
          if (error) {
            const errLine = formatSupabaseError(error);
            console.error("Notch cloud save", errLine, error);
            notchSwLog("MF_CLOUD_SAVE_CLIP owner upsert error", {
              code: error.code,
              message: error.message,
              formatted: errLine,
              platform,
              clipId: clipIdDb,
            });
            sendResponse({ ok: false, error: "save_failed", detail: errLine });
            return;
          }
          if (platform === "dropbox") {
            const pat = sqlLikePrefixFromPath(dropboxPathnameOnlyFromClipId(clipIdDb));
            if (pat) {
              const { error: dedupeErr } = await client
                .from("clip_reviews")
                .delete()
                .eq("platform", "dropbox")
                .eq("user_id", user.id)
                .like("clip_id", pat)
                .neq("clip_id", clipIdDb);
              if (dedupeErr) {
                notchSwLog("MF_CLOUD_SAVE_CLIP dropbox dedupe skipped", { message: dedupeErr.message });
              }
            }
          }
          notchSwLog("MF_CLOUD_SAVE_CLIP ok", {
            platform,
            clipId: clipIdDb,
            commentCount: comments.length,
            mode: "owner",
          });
          sendResponse({ ok: true });
          return;
        }
        if (!hostUserId) {
          sendResponse({ ok: false, error: "invalid_host_binding" });
          return;
        }
        const { data: existingRow, error: loadErr } = await loadClipReviewRow(client, platform, clipId, rowUserId);
        if (loadErr) {
          const errLine = formatSupabaseError(loadErr);
          console.error("Notch cloud save collab load", errLine, loadErr);
          sendResponse({ ok: false, error: "rls_denied_or_no_match", detail: errLine });
          return;
        }
        if (!existingRow?.id || !existingRow?.clip_id) {
          sendResponse({ ok: false, error: "host_row_missing" });
          return;
        }
        const { data: updatedRows, error: updateErr } = await client
          .from("clip_reviews")
          .update({
            comments: commentsPayload,
            title: cloudOptionalTextField(msg.title),
            thumbnail_url: cloudOptionalTextField(msg.thumbnailUrl),
            updated_at: row.updated_at,
          })
          .eq("id", existingRow.id)
          .eq("user_id", rowUserId)
          .eq("platform", platform)
          .eq("clip_id", existingRow.clip_id)
          .select("id")
          .limit(1);
        if (updateErr) {
          const errLine = formatSupabaseError(updateErr);
          console.error("Notch cloud save collab update", errLine, updateErr);
          notchSwLog("MF_CLOUD_SAVE_CLIP collab update error", {
            code: updateErr.code,
            message: updateErr.message,
            formatted: errLine,
            platform,
            clipId: clipIdDb,
            hostUserId,
          });
          sendResponse({ ok: false, error: "rls_denied_or_no_match", detail: errLine });
          return;
        }
        if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
          sendResponse({ ok: false, error: "host_row_missing" });
          return;
        }
        notchSwLog("MF_CLOUD_SAVE_CLIP ok", {
          platform,
          clipId: clipIdDb,
          commentCount: comments.length,
          mode: "collab",
          hostUserId,
          dbClipId: existingRow.clip_id,
        });
        sendResponse({ ok: true });
      } catch (e) {
        console.error("Notch cloud save exception", e);
        sendResponse({ ok: false, error: "save_failed", detail: String(e?.message || e) });
      }
    });
    return true;
  }

  if (msg?.type === "MF_CLOUD_LIST_CLIPS") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ ok: false, items: [] });
      return false;
    }
    getSessionSafe(client).then(({ session, error: sessErr }) => {
      const user = session?.user;
      if (sessErr || !user) {
        sendResponse({ ok: true, items: [] });
        return;
      }
      client
        .from("clip_reviews")
        .select("*")
        .order("updated_at", { ascending: false })
        .then(({ data, error }) => {
          if (error) {
            console.error("Notch cloud list", error);
            sendResponse({ ok: false, items: [] });
            return;
          }
          const rows = (data || []).filter(
            (r) =>
              r &&
              CLIP_PLATFORMS.includes(r.platform) &&
              commentsFromDb(r.comments).length > 0
          );
          sendResponse({ ok: true, items: rows.map(rowToDashboardItem) });
        });
    });
    return true;
  }

  if (msg?.type === "MF_CLOUD_UPDATE_THUMB") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    const thumbnailUrl = msg.thumbnailUrl;
    if (!client || !platform || !clipId || !thumbnailUrl) {
      sendResponse({ ok: false });
      return false;
    }
    getSessionSafe(client).then(({ session, error: sessErr }) => {
      if (sessErr) {
        sendResponse({ ok: false });
        return;
      }
      const thumbUid = session?.user?.id;
      if (!thumbUid) {
        sendResponse({ ok: false });
        return;
      }
      let q = client
        .from("clip_reviews")
        .update({
          thumbnail_url: thumbnailUrl,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", thumbUid)
        .eq("platform", platform);
      if (platform === "dropbox") {
        const canonical = normalizeDropboxClipIdForDb(platform, clipId);
        const pat = sqlLikePrefixFromPath(dropboxPathnameOnlyFromClipId(canonical));
        if (pat) q = q.like("clip_id", pat);
        else q = q.eq("clip_id", clipId);
      } else {
        q = q.eq("clip_id", clipId);
      }
      q.then(({ error }) => {
        if (error) {
          console.error("Notch cloud thumb", error);
          sendResponse({ ok: false });
          return;
        }
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (msg?.type === "MF_CLOUD_DELETE_CLIP") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    if (!client || !platform || !clipId) {
      sendResponse({ ok: false });
      return false;
    }
    getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      if (sessErr) {
        sendResponse({ ok: false });
        return;
      }
      const uid = session?.user?.id;
      if (!uid) {
        sendResponse({ ok: false });
        return;
      }
      let reviewQ = client.from("clip_reviews").delete().eq("user_id", uid).eq("platform", platform);
      if (platform === "dropbox") {
        const canonical = normalizeDropboxClipIdForDb(platform, clipId);
        const pat = sqlLikePrefixFromPath(dropboxPathnameOnlyFromClipId(canonical));
        if (pat) reviewQ = reviewQ.like("clip_id", pat);
        else reviewQ = reviewQ.eq("clip_id", clipId);
      } else {
        reviewQ = reviewQ.eq("clip_id", clipId);
      }
      const { error: reviewErr } = await reviewQ;
      if (reviewErr) {
        console.error("Notch cloud delete clip_reviews", reviewErr);
        sendResponse({ ok: false });
        return;
      }
      let collabQ = client
        .from("clip_review_collaborators")
        .delete()
        .eq("host_user_id", uid)
        .eq("platform", platform);
      if (platform === "dropbox") {
        const canonical = normalizeDropboxClipIdForDb(platform, clipId);
        const pat = sqlLikePrefixFromPath(dropboxPathnameOnlyFromClipId(canonical));
        if (pat) collabQ = collabQ.like("clip_id", pat);
        else collabQ = collabQ.eq("clip_id", clipId);
      } else {
        collabQ = collabQ.eq("clip_id", clipId);
      }
      const { error: collabErr } = await collabQ;
      if (collabErr) {
        console.error("Notch cloud delete clip_review_collaborators", collabErr);
        sendResponse({ ok: false });
        return;
      }
      notchSwLog("MF_CLOUD_DELETE_CLIP ok", { platform, clipId: String(clipId).slice(0, 120) });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "MF_ENSURE_CLIP_REVIEW_ROW") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    if (!client || !platform || !clipId) {
      sendResponse({ ok: false, error: "invalid_args" });
      return false;
    }
    getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      const user = session?.user;
      if (sessErr || !user?.id) {
        sendResponse({ ok: false, error: "not_authenticated" });
        return;
      }
      if (planFromSupabaseUser(user) !== "pro") {
        sendResponse({ ok: false, error: "pro_required" });
        return;
      }
      const clipIdDb = normalizeDropboxClipIdForDb(platform, clipId);
      try {
        const { data: existing, error: loadErr } = await loadClipReviewRow(
          client,
          platform,
          clipId,
          user.id,
        );
        if (loadErr) {
          const errLine = formatSupabaseError(loadErr);
          console.error("Notch ensure clip row load", errLine, loadErr);
          sendResponse({ ok: false, error: "load_failed", detail: errLine });
          return;
        }
        if (existing) {
          const stored =
            existing.clip_id != null && String(existing.clip_id) !== "" ? String(existing.clip_id) : "";
          let clipIdOut = stored || clipIdDb;
          if (
            platform === "dropbox" &&
            /[?&]rlkey=/.test(clipIdDb) &&
            stored &&
            !/[?&]rlkey=/.test(stored)
          ) {
            clipIdOut = clipIdDb;
          }
          sendResponse({
            ok: true,
            userId: user.id,
            platform,
            clipId: clipIdOut,
          });
          return;
        }
        const row = {
          user_id: user.id,
          platform,
          clip_id: clipIdDb,
          comments: [],
          updated_at: new Date().toISOString(),
        };
        const { error: insertErr } = await client.from("clip_reviews").insert(row);
        if (insertErr) {
          if (insertErr.code === "23505") {
            const { data: raced } = await loadClipReviewRow(client, platform, clipId, user.id);
            const storedR =
              raced?.clip_id != null && String(raced.clip_id) !== "" ? String(raced.clip_id) : "";
            let clipIdOutR = storedR || clipIdDb;
            if (
              platform === "dropbox" &&
              /[?&]rlkey=/.test(clipIdDb) &&
              storedR &&
              !/[?&]rlkey=/.test(storedR)
            ) {
              clipIdOutR = clipIdDb;
            }
            sendResponse({
              ok: true,
              userId: user.id,
              platform,
              clipId: clipIdOutR,
            });
            return;
          }
          const errLine = formatSupabaseError(insertErr);
          console.error("Notch ensure clip row insert", errLine, insertErr);
          sendResponse({ ok: false, error: "insert_failed", detail: errLine });
          return;
        }
        if (platform === "dropbox") {
          const pat = sqlLikePrefixFromPath(dropboxPathnameOnlyFromClipId(clipIdDb));
          if (pat) {
            const { error: dedupeErr } = await client
              .from("clip_reviews")
              .delete()
              .eq("platform", "dropbox")
              .eq("user_id", user.id)
              .like("clip_id", pat)
              .neq("clip_id", clipIdDb);
            if (dedupeErr) {
              notchSwLog("MF_ENSURE_CLIP_REVIEW_ROW dropbox dedupe skipped", {
                message: dedupeErr.message,
              });
            }
          }
        }
        sendResponse({
          ok: true,
          userId: user.id,
          platform,
          clipId: clipIdDb,
        });
      } catch (e) {
        console.error("Notch ensure clip row", e);
        sendResponse({ ok: false, error: "ensure_failed", detail: String(e?.message || e) });
      }
    });
    return true;
  }

  if (msg?.type === "MF_JOIN_SHARED_REVIEW") {
    const client = getSupabase();
    const hostUserId = msg.hostUserId != null ? String(msg.hostUserId).trim() : "";
    const platform = msg.platform;
    const clipId = msg.clipId;
    if (!client || !hostUserId || !platform || !clipId) {
      sendResponse({ ok: false, error: "invalid_args" });
      return false;
    }
    getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      if (sessErr || !session?.user) {
        sendResponse({ ok: false, error: "not_authenticated" });
        return;
      }
      const { data, error } = await client.rpc("join_shared_review_link", {
        p_host_user_id: hostUserId,
        p_platform: platform,
        p_clip_id: clipId,
      });
      if (error) {
        console.error("Notch join shared review", error);
        sendResponse({ ok: false, error: error.message || "rpc_error" });
        return;
      }
      const row = data;
      if (row && typeof row === "object" && row.ok === true) {
        sendResponse({ ok: true, isHost: row.is_host === true || row.isHost === true });
        return;
      }
      const err =
        row && typeof row === "object" && typeof row.error === "string" ? row.error : "unknown";
      sendResponse({ ok: false, error: err });
    });
    return true;
  }

  if (msg?.type === "MF_COLLAB_LEAVE") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    const hostUserId = msg.hostUserId;
    if (!client || !platform || !clipId || !hostUserId) {
      sendResponse({ ok: false });
      return false;
    }
    const clipIdDb = normalizeDropboxClipIdForDb(platform, clipId);
    const collabClipId =
      platform === "dropbox" ? dropboxPathnameOnlyFromClipId(clipIdDb) : clipIdDb;
    getSessionSafe(client).then(({ session, error: sessErr }) => {
      const user = session?.user;
      if (sessErr || !user) {
        sendResponse({ ok: false });
        return;
      }
      client
        .from("clip_review_collaborators")
        .delete()
        .eq("host_user_id", hostUserId)
        .eq("platform", platform)
        .eq("clip_id", collabClipId)
        .eq("member_user_id", user.id)
        .then(({ error }) => {
          if (error) {
            console.error("Notch collab leave", error);
            sendResponse({ ok: false });
            return;
          }
          sendResponse({ ok: true });
        });
    });
    return true;
  }

  return false;
}

export async function restoreAuthMarker() {
  try {
    await syncAuthMarkerFromChromeStorage();
    const client = getSupabase();
    if (!client) return;
    const { session, error } = await getSessionSafe(client);
    if (error && !session) return;
    await syncAuthStateMarker(session);
  } catch (e) {
    console.warn("Notch restoreAuthMarker", e?.message || e);
  }
}
