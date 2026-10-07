import { supabaseAdmin } from '@/lib/supabase/admin';
import { encryptToken, decryptToken } from '@/lib/crypto';

/**
 * Direct Gmail OAuth sending, replacing Resend. Calls Google's APIs over
 * plain fetch rather than the googleapis SDK — same reasoning as lib/ai.ts:
 * real HTTP status codes to branch on, and no SDK that wants to own token
 * caching when this app already owns an encrypted token store.
 */

export class GmailError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
  }
}

export type GmailConnection = {
  id: number;
  email: string;
  access_token: string; // encrypted
  refresh_token: string; // encrypted
  expires_at: string;
  scope: string | null;
  created_at: string;
};

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

function redirectUri(): string {
  const base = process.env.OAUTH_REDIRECT_BASE_URL;
  if (!base) throw new GmailError('OAUTH_REDIRECT_BASE_URL is not set.');
  return `${base}/api/auth/google/callback`;
}

async function describeError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    const message = json?.error_description || json?.error?.message || json?.error;
    if (message) return `${res.status}: ${message}`;
  } catch {
    // Not JSON — fall through to raw text.
  }
  return `${res.status}: ${text.slice(0, 300) || res.statusText}`;
}

// -----------------------------------------------------------------------
// OAuth
// -----------------------------------------------------------------------

const SCOPE = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email';

export function buildAuthUrl(state: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new GmailError('GOOGLE_CLIENT_ID is not set.');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    access_type: 'offline',
    // Forces Google to re-issue a refresh_token even on reconnect — it only
    // returns one on first consent otherwise.
    prompt: 'consent',
    scope: SCOPE,
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GmailError('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set.');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
  });

  if (!res.ok) throw new GmailError(await describeError(res), res.status);
  return res.json();
}

export function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  return requestToken({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
}

export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return requestToken({ refresh_token: refreshToken, grant_type: 'refresh_token' });
}

export async function getUserEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new GmailError(await describeError(res), res.status);
  const json = await res.json();
  if (!json.email) throw new GmailError('Google did not return an email address for this account.');
  return json.email;
}

// -----------------------------------------------------------------------
// Connection storage (singleton row — Gmail-only, so no "which provider is
// active" question)
// -----------------------------------------------------------------------

export async function getConnection(): Promise<GmailConnection | null> {
  const { data, error } = await supabaseAdmin
    .from('gmail_connection')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new GmailError(`Could not read the Gmail connection: ${error.message}`);
  return data;
}

export async function saveConnection(params: {
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope?: string;
}) {
  const { error } = await supabaseAdmin.from('gmail_connection').upsert({
    id: 1,
    email: params.email,
    access_token: encryptToken(params.accessToken),
    refresh_token: encryptToken(params.refreshToken),
    expires_at: new Date(Date.now() + params.expiresIn * 1000).toISOString(),
    scope: params.scope ?? null,
    updated_at: new Date().toISOString(),
  });

  if (error) throw new GmailError(`Could not save the Gmail connection: ${error.message}`);
}

export async function deleteConnection() {
  const { error } = await supabaseAdmin.from('gmail_connection').delete().eq('id', 1);
  if (error) throw new GmailError(`Could not remove the Gmail connection: ${error.message}`);
}

const REFRESH_SKEW_MS = 2 * 60 * 1000; // refresh if expiring within 2 minutes

/** Returns a usable plaintext access token, refreshing (and persisting) first if needed. */
export async function getValidAccessToken(conn: GmailConnection): Promise<string> {
  if (new Date(conn.expires_at).getTime() - Date.now() > REFRESH_SKEW_MS) {
    return decryptToken(conn.access_token);
  }

  const refreshToken = decryptToken(conn.refresh_token);
  const fresh = await refreshAccessToken(refreshToken);

  const { error } = await supabaseAdmin
    .from('gmail_connection')
    .update({
      access_token: encryptToken(fresh.access_token),
      // Google usually doesn't rotate the refresh token on refresh — keep the
      // existing encrypted one rather than overwriting it with undefined.
      refresh_token: fresh.refresh_token ? encryptToken(fresh.refresh_token) : conn.refresh_token,
      expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conn.id);

  if (error) console.error('Failed to persist refreshed Gmail token:', error);

  return fresh.access_token;
}

// -----------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------

type MailInput = { from: string; to: string; subject: string; text: string };

function buildRawMessage({ from, to, subject, text }: MailInput): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
  ].join('\r\n');

  return Buffer.from(message, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sendViaGmail(
  accessToken: string,
  mail: MailInput
): Promise<{ id?: string }> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildRawMessage(mail) }),
  });

  if (!res.ok) throw new GmailError(await describeError(res), res.status);
  const json = await res.json();
  return { id: json.id };
}
