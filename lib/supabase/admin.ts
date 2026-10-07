import { createClient } from '@supabase/supabase-js';
 
/**
 * Service-role client. Bypasses RLS entirely.
 *
 * NEVER import this into a file with 'use client' at the top, and never give
 * it a NEXT_PUBLIC_ env var. It only exists so route handlers can write to
 * leads after they have already verified the caller is authenticated.
 */
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
 