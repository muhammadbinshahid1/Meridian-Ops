import { createBrowserClient } from '@supabase/ssr';
 
/**
 * Browser client. Uses the anon key, which is safe to expose ONLY because
 * RLS is enabled and every policy requires an authenticated session.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
 