import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getUser } from '@/lib/supabase/server';
import { buildAuthUrl } from '@/lib/gmail';

export async function GET() {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const state = randomBytes(16).toString('hex');
  const response = NextResponse.redirect(buildAuthUrl(state));

  // sameSite must be 'lax', not 'strict' — the callback is a top-level
  // cross-site redirect landing back from Google, and 'strict' would
  // silently drop this cookie, breaking CSRF validation for every user.
  response.cookies.set('gmail_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  return response;
}
