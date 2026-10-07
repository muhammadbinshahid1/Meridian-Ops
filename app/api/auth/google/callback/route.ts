import { NextResponse, type NextRequest } from 'next/server';
import { getUser } from '@/lib/supabase/server';
import { exchangeCodeForTokens, getUserEmail, saveConnection } from '@/lib/gmail';

function redirectWith(request: NextRequest, query: Record<string, string>) {
  const url = new URL('/', request.url);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = NextResponse.redirect(url);
  response.cookies.delete('gmail_oauth_state');
  return response;
}

export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const cookieState = request.cookies.get('gmail_oauth_state')?.value;

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectWith(request, {
      connect_error: 'The connection request could not be verified. Try again.',
    });
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    if (!tokens.refresh_token) {
      // Shouldn't happen with prompt=consent, but if it does there's nothing
      // to refresh with later — surface it rather than storing an empty
      // refresh token that will fail the first time it's needed.
      return redirectWith(request, {
        connect_error:
          'Google did not grant offline access. Remove Meridian at myaccount.google.com/permissions and try connecting again.',
      });
    }

    const email = await getUserEmail(tokens.access_token);

    await saveConnection({
      email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    });

    return redirectWith(request, { connected: '1' });
  } catch (err) {
    console.error('Gmail OAuth callback failed:', err);
    const message = err instanceof Error ? err.message : 'Could not connect Gmail.';
    return redirectWith(request, { connect_error: message });
  }
}
