import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server client bound to the request's cookies. Use this to find out WHO is
 * calling a route handler. Do not use it for privileged writes — use the
 * admin client for those.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — middleware refreshes the
            // session instead, so this is safe to swallow.
          }
        },
      },
    }
  );
}

/** Returns the signed-in user, or null. */
export async function getUser() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}