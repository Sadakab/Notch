// Paste the client-safe key from Supabase → Project Settings → API:
//   • "anon" / "publishable" key (legacy JWT starting with eyJ…, or sb_publishable_…)
// Never put sb_secret_ or service_role here — those bypass RLS and must not ship in the extension.
// Then run: npm run build
export const SUPABASE_URL = "https://qsecybzfpleplpqzsrza.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_g3bQl0sI2ZsxAlTVysDhOA_3VPqRPc2";
