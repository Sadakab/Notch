/** Keys safe to embed in the extension (RLS-respecting). Reject backend-only secrets. */
export function isClientSafeSupabaseKey(key) {
  if (!key || typeof key !== "string") return false;
  const t = key.trim();
  if (!t) return false;
  if (t.startsWith("sb_secret_")) return false;
  if (t.startsWith("service_role")) return false;
  return true;
}
