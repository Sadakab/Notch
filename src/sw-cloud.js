import { createClient } from "@supabase/supabase-js";
import { isClientSafeSupabaseKey } from "./supabase-client-key.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const AUTH_STORAGE_KEY = "sb-notch-auth";
const AUTH_STATE_KEY = "markframe_auth_state";

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

/** Dropbox: store/query path without ?volatile= params so refresh keeps the same clip_id. */
function normalizeDropboxClipIdForDb(platform, clipId) {
  if (platform !== "dropbox" || typeof clipId !== "string" || !clipId) return clipId;
  const q = clipId.indexOf("?");
  return q === -1 ? clipId : clipId.slice(0, q);
}

/** Escape for PostgreSQL LIKE; append % to match legacy rows saved as path?query… */
function sqlLikePrefixFromPath(pathPrefix) {
  if (pathPrefix == null || typeof pathPrefix !== "string" || pathPrefix.length === 0) return null;
  return pathPrefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
async function loadClipReviewRow(client, platform, clipId) {
  if (platform === "dropbox") {
    const canonical = normalizeDropboxClipIdForDb(platform, clipId);
    const r1 = await client
      .from("clip_reviews")
      .select("*")
      .eq("platform", "dropbox")
      .eq("clip_id", canonical)
      .maybeSingle();
    if (r1.error) return { data: null, error: r1.error };
    if (r1.data) return { data: r1.data, error: null };
    const pat = sqlLikePrefixFromPath(canonical);
    if (!pat) return { data: null, error: null };
    const r2 = await client
      .from("clip_reviews")
      .select("*")
      .eq("platform", "dropbox")
      .like("clip_id", pat)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (r2.error) return { data: null, error: r2.error };
    const row = r2.data?.[0] ?? null;
    if (row) {
      notchSwLog("MF_CLOUD_LOAD_CLIP dropbox legacy prefix match", {
        requested: clipId.slice(0, 80),
        canonical: canonical.slice(0, 80),
        dbClipIdPrefix: String(row.clip_id).slice(0, 80),
      });
    }
    return { data: row, error: null };
  }
  const r = await client
    .from("clip_reviews")
    .select("*")
    .eq("platform", platform)
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
      },
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      void syncAuthStateMarker(session);
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
  };
}

/**
 * @returns {boolean} true if sendResponse will be called asynchronously
 */
export function handleRuntimeMessage(msg, sendResponse) {
  if (msg?.type === "MF_AUTH_SIGN_IN") {
    const email = String(msg.email || "").trim();
    const password = String(msg.password || "");
    if (!email || !password) {
      sendResponse({ ok: false, error: "Enter email and password." });
      return false;
    }
    void (async () => {
      try {
        const client = getSupabase();
        if (!client) {
          sendResponse({ ok: false, error: "Supabase is not configured." });
          return;
        }
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) {
          sendResponse({ ok: false, error: error.message });
          return;
        }
        const session = data?.session ?? null;
        await syncAuthStateMarker(session);
        await syncAuthMarkerFromChromeStorage();
        sendResponse({ ok: true, email: session?.user?.email ?? null });
      } catch (e) {
        console.error("Notch MF_AUTH_SIGN_IN", e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg?.type === "MF_AUTH_SIGN_UP") {
    const email = String(msg.email || "").trim();
    const password = String(msg.password || "");
    if (!email || !password) {
      sendResponse({ ok: false, error: "Enter email and password." });
      return false;
    }
    if (password.length < 6) {
      sendResponse({ ok: false, error: "Password must be at least 6 characters." });
      return false;
    }
    void (async () => {
      try {
        const client = getSupabase();
        if (!client) {
          sendResponse({ ok: false, error: "Supabase is not configured." });
          return;
        }
        const { data, error } = await client.auth.signUp({ email, password });
        if (error) {
          sendResponse({ ok: false, error: error.message });
          return;
        }
        const session = data?.session ?? null;
        if (session?.user) {
          await syncAuthStateMarker(session);
          await syncAuthMarkerFromChromeStorage();
          sendResponse({
            ok: true,
            email: session.user.email ?? null,
            needsEmailConfirm: false,
          });
        } else {
          sendResponse({
            ok: true,
            email: null,
            needsEmailConfirm: true,
            message:
              "Check your email to confirm your account (if confirmation is enabled), then sign in.",
          });
        }
      } catch (e) {
        console.error("Notch MF_AUTH_SIGN_UP", e);
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
        const {
          data: { session },
          error,
        } = await client.auth.getSession();
        if (error) {
          sendResponse({ ok: false });
          return;
        }
        void syncAuthStateMarker(session);
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
    client.auth.getSession().then(({ data: { session }, error }) => {
      if (error) {
        sendResponse({ configured: true, user: null, error: error.message });
        return;
      }
      const u = session?.user;
      sendResponse({
        configured: true,
        user: u ? { id: u.id, email: u.email } : null,
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
    client.auth.getSession().then(async ({ data: { session }, error: sessErr }) => {
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
        const { data, error } = await loadClipReviewRow(client, platform, clipId);
        if (error) {
          console.error("Notch cloud load", error);
          notchSwLog("MF_CLOUD_LOAD_CLIP query error", {
            code: error.code,
            message: error.message,
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
    });
    if (!client || !platform || !clipId || !Array.isArray(comments)) {
      notchSwLog("MF_CLOUD_SAVE_CLIP abort: bad args");
      sendResponse({ ok: false });
      return false;
    }
    client.auth.getSession().then(async ({ data: { session }, error: sessErr }) => {
      const user = session?.user;
      if (sessErr || !user) {
        sendResponse({ ok: false });
        return;
      }
      const clipIdDb = normalizeDropboxClipIdForDb(platform, clipId);
      const row = {
        user_id: user.id,
        platform,
        clip_id: clipIdDb,
        comments,
        title: msg.title ?? null,
        thumbnail_url: msg.thumbnailUrl ?? null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await client.from("clip_reviews").upsert(row, { onConflict: "user_id,platform,clip_id" });
      if (error) {
        console.error("Notch cloud save", error);
        notchSwLog("MF_CLOUD_SAVE_CLIP error", {
          code: error.code,
          message: error.message,
          platform,
          clipId,
        });
        sendResponse({ ok: false });
        return;
      }
      if (platform === "dropbox") {
        const pat = sqlLikePrefixFromPath(clipIdDb);
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
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "MF_CLOUD_LIST_CLIPS") {
    const client = getSupabase();
    if (!client) {
      sendResponse({ ok: false, items: [] });
      return false;
    }
    client.auth.getSession().then(({ data: { session }, error: sessErr }) => {
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
    let q = client
      .from("clip_reviews")
      .update({
        thumbnail_url: thumbnailUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("platform", platform);
    if (platform === "dropbox") {
      const canonical = normalizeDropboxClipIdForDb(platform, clipId);
      const pat = sqlLikePrefixFromPath(canonical);
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
    let q = client.from("clip_reviews").delete().eq("platform", platform);
    if (platform === "dropbox") {
      const canonical = normalizeDropboxClipIdForDb(platform, clipId);
      const pat = sqlLikePrefixFromPath(canonical);
      if (pat) q = q.like("clip_id", pat);
      else q = q.eq("clip_id", clipId);
    } else {
      q = q.eq("clip_id", clipId);
    }
    q.then(({ error }) => {
      if (error) {
        console.error("Notch cloud delete", error);
        sendResponse({ ok: false });
        return;
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
}

export async function restoreAuthMarker() {
  await syncAuthMarkerFromChromeStorage();
  const client = getSupabase();
  if (!client) return;
  const {
    data: { session },
  } = await client.auth.getSession();
  await syncAuthStateMarker(session);
}
