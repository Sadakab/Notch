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
    const canonical = normalizeDropboxClipIdForDb(platform, clipId);
    const r1 = await client
      .from("clip_reviews")
      .select("*")
      .eq("platform", "dropbox")
      .eq("user_id", clipOwnerUserId)
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
      .eq("user_id", clipOwnerUserId)
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

/** Safe in MV3 SW: never destructure `data.session` (missing `data` throws). */
async function getSessionSafe(client) {
  try {
    const result = await client.auth.getSession();
    const err = result?.error ?? null;
    const session = result?.data?.session ?? null;
    if (err) {
      console.warn("Notch getSession", err.message ?? err);
    }
    return { session, error: err };
  } catch (e) {
    console.warn("Notch getSession", e?.message || e);
    return { session: null, error: e };
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
    getSessionSafe(client).then(({ session, error: sessErr }) => {
      if (sessErr) {
        sendResponse({ ok: false });
        return;
      }
      const uid = session?.user?.id;
      if (!uid) {
        sendResponse({ ok: false });
        return;
      }
      let q = client.from("clip_reviews").delete().eq("user_id", uid).eq("platform", platform);
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
    });
    return true;
  }

  if (msg?.type === "MF_INVITE_CREATE") {
    const client = getSupabase();
    const platform = msg.platform;
    const clipId = msg.clipId;
    if (!client || !platform || !clipId) {
      sendResponse({ ok: false, error: "invalid_args" });
      return false;
    }
    getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      const user = session?.user;
      if (sessErr || !user) {
        sendResponse({ ok: false, error: "not_authenticated" });
        return;
      }
      const { data, error } = await client.rpc("create_review_invite", {
        p_platform: platform,
        p_clip_id: clipId,
      });
      if (error) {
        console.error("Notch invite create", error);
        sendResponse({ ok: false, error: error.message || "rpc_error" });
        return;
      }
      const row = data;
      if (row && typeof row === "object" && row.ok === true && typeof row.code === "string") {
        sendResponse({ ok: true, code: row.code });
        return;
      }
      const err =
        row && typeof row === "object" && typeof row.error === "string" ? row.error : "unknown";
      sendResponse({ ok: false, error: err });
    });
    return true;
  }

  if (msg?.type === "MF_INVITE_REDEEM") {
    const client = getSupabase();
    const code = String(msg.code || "").trim();
    if (!client || !code) {
      sendResponse({ ok: false, error: "invalid_args" });
      return false;
    }
    getSessionSafe(client).then(async ({ session, error: sessErr }) => {
      if (sessErr || !session?.user) {
        sendResponse({ ok: false, error: "not_authenticated" });
        return;
      }
      const { data, error } = await client.rpc("redeem_review_invite", { p_code: code });
      if (error) {
        console.error("Notch invite redeem", error);
        sendResponse({ ok: false, error: error.message || "rpc_error" });
        return;
      }
      const row = data;
      if (row && typeof row === "object" && row.ok === true) {
        const hidRaw = row.host_user_id ?? row.hostUserId;
        const hid = hidRaw != null && String(hidRaw).trim() !== "" ? String(hidRaw).trim() : null;
        sendResponse({
          ok: true,
          hostUserId: hid,
          platform: row.platform != null ? String(row.platform) : null,
          clipId: row.clip_id != null ? String(row.clip_id) : row.clipId != null ? String(row.clipId) : null,
          isHost: row.is_host === true || row.isHost === true,
        });
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
        .eq("clip_id", clipIdDb)
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
