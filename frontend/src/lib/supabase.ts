import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

/** False when the deployment forgot to set the public Supabase settings; the app shows a clear message instead of crashing. */
export const isConfigured = Boolean(url && anon && !url.includes("YOUR-PROJECT"))

// The anon key is public by design; all authorisation happens in the backend and in database RLS.
export const supabase: SupabaseClient = createClient(url ?? "http://localhost", anon ?? "missing", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})
