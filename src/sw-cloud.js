import { createClient } from "@supabase/supabase-js";
import { isClientSafeSupabaseKey } from "./supabase-client-key.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const AUTH_STORAGE_KEY = "sb-notch-auth";
const AUTH_STATE_KEY = "markframe_auth_state";
const AUTH_CONFIRM_URL = "https://notch.so/auth/confirm";

const CLIP_PLATFORMS = ["youtube", "vimeo", "loom", "googledrive", "dropbox"];

function notchSwLog() {}

function planFromSupabaseUser(u) {
  if (!u) return "free";
  const raw =
    u.app_metadata?.plan ||
    u.user_metadata?.plan ||
    u.app_metadata?.tier ||
    u.user_metadata?.tier;
  return String(raw || "").trim().toLowerCase() === "pro" ? "pro" : "free";
}

const PREFERENCE_DEFAULTS = {
  displayName: "",
  companyName: "",
  avatar: null,
  logoDataUrl: null,
  panelPosition: "bottom-right",
  autoPause: true,
  floatPanel: false,
  timestampFormat: "short",
  notifyOnComment: true,
  notifyOnReaction: true,
  notifyOnReply: true,
};

function normalizePanelPositionValue(v) {
  const p = String(v || "").trim().toLowerCase();
  if (p === "top-left" || p === "top left" || p === "tl") return "top-left";
  if (p === "top-right" || p === "top right" || p === "tr") return "top-right";
  if (p === "bottom-left" || p === "bottom left" || p === "bl") return "bottom-left";
  return "bottom-right";
}

function normalizeTimestampFormatValue(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "long" || s === "00:00:39" ? "long" : "short";
}

function normalizePreferences(input) {
  const src = input && typeof input === "object" ? input : {};
  const avatarRaw = src.avatar;
  const logoRaw = src.logoDataUrl;
  const avatar =
    typeof avatarRaw === "string" &&
    (avatarRaw.startsWith("data:image/") || avatarRaw.startsWith("https://"))
      ? avatarRaw
      : null;
  const logo =
    typeof logoRaw === "string" && (logoRaw.startsWith("data:image/") || logoRaw.startsWith("https://"))
      ? logoRaw
      : null;
  return {
    displayName: String(src.displayName || "").trim(),
    companyName: String(src.companyName || "").trim(),
    avatar,
    logoDataUrl: logo,
    panelPosition: normalizePanelPositionValue(src.panelPosition),
    autoPause: src.autoPause !== false,
    floatPanel: !!src.floatPanel,
    timestampFormat: normalizeTimestampFormatValue(src.timestampFormat),
    notifyOnComment: src.notifyOnComment !== false,
    notifyOnReaction: src.notifyOnReaction !== false,
    notifyOnReply: src.notifyOnReply !== false,
  };
}

function preferencesFromSupabaseUser(u) {
  const meta = u?.user_metadata && typeof u.user_metadata === "object" ? u.user_metadata : {};
  return normalizePreferences({ ...PREFERENCE_DEFAULTS, ...meta });
}

const REACTOR_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUserIdForPublicProfileQuery(raw) {
  const s = String(raw || "").trim();
  if (!REACTOR_UUID_RE.test(s)) return "";
  return s.toLowerCase();
}

/** Synced to user_public_profiles; uses metadata first (defaults to email once ensure* runs). */
function displayNameForPublicProfileFromUser(user) {
  if (!user) return "";
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const fromMeta = String(meta.displayName ?? "").trim();
  const email = String(user.email ?? "").trim();
  return fromMeta || email;
}

/**
 * New accounts often have no displayName in user_metadata; set it to email before public profile upsert.
 * @returns {Promise<import("@supabase/supabase-js").User>} Same user, or updated user from Auth.
 */
async function ensureUserMetadataDisplayNameDefaultsToEmail(client, user) {
  if (!user || !client) return user;
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const existing = String(meta.displayName ?? "").trim();
  if (existing) return user;
  const email = String(user.email ?? "").trim();
  if (!email) return user;
  const data = { ...meta, displayName: email };
  const { data: updated, error } = await client.auth.updateUser({ data });
  if (error || !updated?.user) return user;
  return updated.user;
}

async function upsertUserPublicDisplayName(client, user, displayName) {
  if (!user || !client) return;
  const id = String(user.id || "").trim();
  if (!id) return;

  console.log("[Notch] upserting user_public_profiles:", {
    id: user.id,
    displayName: user.user_metadata?.displayName,
    email: user.email,
    fullUserMetadata: user.user_metadata,
  });

  const nm = String(displayName || "").trim();
  const { data, error } = await client.from("user_public_profiles").upsert(
    { id, display_name: nm, updated_at: new Date().toISOString() },
    { onConflict: "id" }
  );

  console.log("[Notch] user_public_profiles upsert result:", { data, error });

  if (error) {
    try {
      notchSwLog("user_public_profiles upsert", { message: error.message });
    } catch {
      /* noop */
    }
  }
}

function billingPortalUrlFromSupabaseUser(u) {
  const app = u?.app_metadata && typeof u.app_metadata === "object" ? u.app_metadata : {};
  const raw =
    app.billing_portal_url ||
    app.billingPortalUrl ||
    app.billing_portal ||
    app.billingPortal ||
    "";
  return String(raw || "").trim();
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

async function loadReviewOwnerEmail(client, hostUserId, platform, clipId) {
  if (!hostUserId || !platform || !clipId) return null;
  try {
    const { data, error } = await client.rpc("review_owner_email_for_clip", {
      p_host_user_id: hostUserId,
      p_platform: platform,
      p_clip_id: clipId,
    });
    if (error) {
      notchSwLog("review_owner_email_for_clip rpc failed", {
        code: error.code,
        message: error.message,
      });
      return null;
    }
    const email = typeof data === "string" ? data.trim() : "";
    return email || null;
  } catch (e) {
    notchSwLog("review_owner_email_for_clip threw", String(e?.message || e));
    return null;
  }
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
        } catch (e) {}
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
    }
    return { session, error: err };
  } catch (e) {
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
  const sessionUser = data?.session?.user ?? null;
  if (sessionUser) {
    const user = await ensureUserMetadataDisplayNameDefaultsToEmail(client, sessionUser);
    void upsertUserPublicDisplayName(client, user, displayNameForPublicProfileFromUser(user));
  }
  const { session: latest } = await getSessionSafe(client);
  await syncAuthStateMarker(latest ?? data?.session ?? null);
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
    reviewId: row.id != null ? String(row.id) : "",
    comments: commentsFromDb(row.comments),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    title: row.title ?? null,
    thumbnailUrl: row.thumbnail_url ?? null,
    platform: row.platform,
    clipId: row.clip_id,
    reviewOwnerUserId: row.user_id ?? null,
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

const clipRealtimeByTabId = new Map();

function isRealtimeRowMatch(platform, expectedClipId, rowClipId) {
  const expected = String(expectedClipId || "");
  const actual = String(rowClipId || "");
  if (platform !== "dropbox") return expected === actual;
  if (expected === actual) return true;
  const expectedPath = dropboxPathnameOnlyFromClipId(expected);
  const actualPath = dropboxPathnameOnlyFromClipId(actual);
  return !!expectedPath && expectedPath === actualPath;
}

async function unsubscribeClipRealtimeByTabId(tabId) {
  if (tabId == null) return;
  const prior = clipRealtimeByTabId.get(tabId);
  clipRealtimeByTabId.delete(tabId);
  if (!prior) return;
  try {
    await prior.client.removeChannel(prior.channel);
  } catch {
    /* noop */
  }
}

export async function cleanupRealtimeForTab(tabId) {
  await unsubscribeClipRealtimeByTabId(tabId);
}

async function subscribeClipRealtimeForTab(tabId, platform, clipId, hostUserId) {
  const client = getSupabase();
  if (!client || tabId == null || !platform || !clipId) return { ok: false, error: "invalid_args" };
  const { session, error: sessErr } = await getSessionSafe(client);
  const sessionUserId = session?.user?.id;
  if (sessErr || !sessionUserId) return { ok: false, error: "not_authenticated" };
  const ownerUserId = rowUserIdFromHostMessage(hostUserId, sessionUserId);
  const normalizedClipId = normalizeDropboxClipIdForDb(platform, clipId);
  await unsubscribeClipRealtimeByTabId(tabId);
  const channel = client
    .channel(`clip-reactions-${tabId}-${Date.now()}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "clip_reviews",
        filter: `user_id=eq.${ownerUserId}`,
      },
      (payload) => {
        const row = payload?.new;
        if (!row || row.platform !== platform) return;
        if (!isRealtimeRowMatch(platform, normalizedClipId, row.clip_id)) return;
        void chrome.tabs.sendMessage(tabId, {
          type: "MF_CLOUD_CLIP_UPDATED",
          record: rowToPayload(row),
        });
      },
    );
  channel.subscribe();
  clipRealtimeByTabId.set(tabId, { client, channel });
  return { ok: true };
}

/**
 * @returns {boolean} true if sendResponse will be called asynchronously
 */
export function handleRuntimeMessage(msg, sendResponse, sender) {
  if (msg?.type === "MF_CLOUD_SUBSCRIBE_CLIP_REACTIONS") {
    void (async () => {
      const tabId = sender?.tab?.id;
      const platform = msg.platform;
      const clipId = msg.clipId;
      const hostUserId = msg.hostUserId;
      const result = await subscribeClipRealtimeForTab(tabId, platform, clipId, hostUserId);
      sendResponse(result);
    })();
    return true;
  }

  if (msg?.type === "MF_CLOUD_UNSUBSCRIBE_CLIP_REACTIONS") {
    void (async () => {
      const tabId = sender?.tab?.id;
      await unsubscribeClipRealtimeByTabId(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

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
        let { session, error } = await getSessionSafe(client);
        if (error && !session) {
          sendResponse({ ok: false });
          return;
        }
        if (session?.user) {
          const user = await ensureUserMetadataDisplayNameDefaultsToEmail(client, session.user);
          void upsertUserPublicDisplayName(client, user, displayNameForPublicProfileFromUser(user));
          const refreshed = await getSessionSafe(client);
          if (!refreshed.error && refreshed.session) {
            session = refreshed.session;
          }
        }
        try {
          await syncAuthStateMarker(session);
        } catch (e) {
        }
        sendResponse({ ok: true, email: session?.user?.email ?? null });
      } catch (e) {
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
      void Promise.all([chrome.storage.local.clear(), chrome.storage.sync.clear()]).then(() => {
        sendResponse({ ok: true });
      });
      return false;
    }
    client.auth.signOut().then(async () => {
      invalidateSupabaseClient();
      await Promise.all([chrome.storage.local.clear(), chrome.storage.sync.clear()]);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "MF_SUPABASE_GET_USER") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ ok: false, configured: false, user: null });
      return false;
    }
    void client.auth
      .getUser()
      .then(async ({ data, error }) => {
        if (error) {
          sendResponse({
            ok: false,
            configured: true,
            user: null,
            error: String(error?.message ?? error ?? ""),
          });
          return;
        }
        let user = data?.user ?? null;
        if (user) {
          user = await ensureUserMetadataDisplayNameDefaultsToEmail(client, user);
          void upsertUserPublicDisplayName(client, user, displayNameForPublicProfileFromUser(user));
        }
        const plan = planFromSupabaseUser(user);
        const preferences = preferencesFromSupabaseUser(user);
        const billingPortalUrl = billingPortalUrlFromSupabaseUser(user);
        sendResponse({
          ok: true,
          configured: true,
          user: user
            ? { id: user.id, email: user.email, plan, billingPortalUrl, preferences }
            : null,
        });
      })
      .catch((e) => {
        sendResponse({ ok: false, configured: true, user: null, error: String(e?.message || e) });
      });
    return true;
  }

  if (msg?.type === "MF_SUPABASE_SET_PREFERENCES") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ ok: false, error: "not_configured" });
      return false;
    }
    const incoming = normalizePreferences(msg.preferences || {});
    void getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      const user = session?.user;
      if (sessErr || !user) {
        sendResponse({ ok: false, error: "not_authenticated" });
        return;
      }
      const currentMeta =
        user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
      const data = { ...currentMeta, ...incoming };
      const { data: updated, error } = await client.auth.updateUser({ data });
      if (error) {
        sendResponse({ ok: false, error: error.message || "save_failed" });
        return;
      }
      const resolvedUser = updated?.user ?? user;
      const prefs = preferencesFromSupabaseUser(resolvedUser);
      void upsertUserPublicDisplayName(
        client,
        resolvedUser,
        displayNameForPublicProfileFromUser(resolvedUser)
      );
      sendResponse({
        ok: true,
        preferences: prefs,
      });
    });
    return true;
  }

  if (msg?.type === "MF_SUPABASE_FETCH_PUBLIC_DISPLAY_NAMES") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ ok: false, error: "not_configured", names: {} });
      return false;
    }
    void getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      if (sessErr || !session?.user) {
        sendResponse({ ok: false, error: "not_authenticated", names: {} });
        return;
      }
      const rawIds = Array.isArray(msg.userIds) ? msg.userIds : [];
      const seen = new Set();
      const unique = [];
      for (const x of rawIds) {
        const id = normalizeUserIdForPublicProfileQuery(x);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        unique.push(id);
        if (unique.length >= 120) break;
      }
      if (!unique.length) {
        sendResponse({ ok: true, names: {} });
        return;
      }
      const names = {};
      const chunkSize = 40;
      try {
        for (let i = 0; i < unique.length; i += chunkSize) {
          const chunk = unique.slice(i, i + chunkSize);
          const { data, error: qErr } = await client
            .from("user_public_profiles")
            .select("id, display_name")
            .in("id", chunk);
          if (qErr) {
            sendResponse({ ok: false, error: qErr.message, names: {} });
            return;
          }
          for (const row of data || []) {
            const rid = row.id ? String(row.id).trim().toLowerCase() : "";
            const nm = String(row.display_name || "").trim();
            if (rid && nm) names[rid] = nm;
          }
        }
        sendResponse({ ok: true, names });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e), names: {} });
      }
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
        let record = data ? rowToPayload(data) : null;
        if (record && record.reviewOwnerUserId) {
          const ownerEmail = await loadReviewOwnerEmail(client, record.reviewOwnerUserId, platform, data.clip_id);
          if (ownerEmail) {
            record = { ...record, reviewOwnerEmail: ownerEmail };
          }
        }
        notchSwLog("MF_CLOUD_LOAD_CLIP payload", {
          recordNull: record == null,
          payloadCommentCount: record?.comments?.length ?? "n/a",
        });
        sendResponse({ ok: true, record });
      } catch (e) {
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
          const { data, error } = await client
            .from("clip_reviews")
            .upsert(row, { onConflict: "user_id,platform,clip_id" })
            .select("id")
            .single();
          if (error) {
            const errLine = formatSupabaseError(error);
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
          sendResponse({
            ok: true,
            reviewId: data?.id != null ? String(data.id) : "",
            sharedReview: false,
            hostUserId: null,
          });
          return;
        }
        if (!hostUserId) {
          sendResponse({ ok: false, error: "invalid_host_binding" });
          return;
        }
        const { data: existingRow, error: loadErr } = await loadClipReviewRow(client, platform, clipId, rowUserId);
        if (loadErr) {
          const errLine = formatSupabaseError(loadErr);
          sendResponse({ ok: false, error: "rls_denied_or_no_match", detail: errLine });
          return;
        }
        if (!existingRow?.id || !existingRow?.clip_id) {
          sendResponse({ ok: false, error: "host_row_missing" });
          return;
        }
        const { data: updatedRow, error: updateErr } = await client
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
          .single();
        if (updateErr) {
          const errLine = formatSupabaseError(updateErr);
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
        if (!updatedRow?.id) {
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
        sendResponse({
          ok: true,
          reviewId: String(updatedRow.id),
          sharedReview: true,
          hostUserId,
        });
      } catch (e) {
        sendResponse({ ok: false, error: "save_failed", detail: String(e?.message || e) });
      }
    });
    return true;
  }

  if (msg?.type === "MF_GUEST_CLOUD_LOAD_CLIP") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    const hostUserId = normalizedHostUserId(msg.hostUserId);
    notchSwLog("MF_GUEST_CLOUD_LOAD_CLIP request", { platform, clipId, hasClient: !!client, hostUserId: !!hostUserId });
    if (!client || !platform || !clipId || !hostUserId) {
      sendResponse({ ok: false, record: null, error: "invalid_args" });
      return false;
    }
    void (async () => {
      try {
        const clipIdDb = normalizeDropboxClipIdForDb(platform, clipId);
        const { data, error } = await client.rpc("guest_load_shared_review", {
          p_host_user_id: hostUserId,
          p_platform: platform,
          p_clip_id: clipIdDb,
        });
        if (error) {
          notchSwLog("MF_GUEST_CLOUD_LOAD_CLIP rpc error", {
            code: error.code,
            message: error.message,
          });
          sendResponse({ ok: false, record: null, error: "rpc_error" });
          return;
        }
        const payload = data && typeof data === "object" ? data : null;
        if (!payload?.ok) {
          sendResponse({
            ok: false,
            record: null,
            error: String(payload?.error || "load_failed"),
          });
          return;
        }
        const rec = payload.record;
        if (!rec || typeof rec !== "object") {
          sendResponse({ ok: false, record: null, error: "no_record" });
          return;
        }
        const fakeRow = {
          id: rec.id,
          user_id: rec.user_id,
          platform: rec.platform,
          clip_id: rec.clip_id,
          comments: rec.comments,
          title: rec.title ?? null,
          thumbnail_url: rec.thumbnail_url ?? null,
          updated_at: rec.updated_at,
        };
        sendResponse({ ok: true, record: rowToPayload(fakeRow) });
      } catch (e) {
        notchSwLog("MF_GUEST_CLOUD_LOAD_CLIP threw", String(e?.message || e));
        sendResponse({ ok: false, record: null, error: "exception" });
      }
    })();
    return true;
  }

  if (msg?.type === "MF_GUEST_CLOUD_SAVE_CLIP") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    const comments = msg.comments;
    const hostUserId = normalizedHostUserId(msg.hostUserId);
    notchSwLog("MF_GUEST_CLOUD_SAVE_CLIP request", {
      platform,
      clipId,
      hasClient: !!client,
      hostUserId: !!hostUserId,
      commentCount: Array.isArray(comments) ? comments.length : "n/a",
    });
    if (!client || !platform || !clipId || !Array.isArray(comments) || !hostUserId) {
      sendResponse({ ok: false, error: "invalid_args" });
      return false;
    }
    void (async () => {
      try {
        const clipIdDb = normalizeDropboxClipIdForDb(platform, clipId);
        let commentsPayload = comments;
        try {
          commentsPayload = JSON.parse(JSON.stringify(comments));
        } catch {
          /* use raw */
        }
        const { data, error } = await client.rpc("guest_update_shared_review", {
          p_host_user_id: hostUserId,
          p_platform: platform,
          p_clip_id: clipIdDb,
          p_comments: commentsPayload,
          p_title: cloudOptionalTextField(msg.title),
          p_thumbnail_url: cloudOptionalTextField(msg.thumbnailUrl),
        });
        if (error) {
          notchSwLog("MF_GUEST_CLOUD_SAVE_CLIP rpc error", {
            code: error.code,
            message: error.message,
          });
          sendResponse({ ok: false, error: "rpc_error" });
          return;
        }
        const payload = data && typeof data === "object" ? data : null;
        if (!payload?.ok) {
          sendResponse({ ok: false, error: String(payload?.error || "save_failed") });
          return;
        }
        const rid = payload.review_id;
        sendResponse({
          ok: true,
          reviewId: rid != null ? String(rid) : "",
          sharedReview: true,
          hostUserId,
        });
      } catch (e) {
        notchSwLog("MF_GUEST_CLOUD_SAVE_CLIP threw", String(e?.message || e));
        sendResponse({ ok: false, error: "exception" });
      }
    })();
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
            /** auth.users id / clip_reviews.user_id — not clip_reviews.id */
            hostUserId: user.id,
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
              hostUserId: user.id,
              platform,
              clipId: clipIdOutR,
            });
            return;
          }
          const errLine = formatSupabaseError(insertErr);
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
          hostUserId: user.id,
          platform,
          clipId: clipIdDb,
        });
      } catch (e) {
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
  }
}
