import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

/**
 * AES-256-GCM for OAuth tokens at rest. RLS keeps the Supabase anon/
 * authenticated roles out of gmail_connection, but that's not the same
 * protection a secret needs against a pg_dump/backup or a human browsing the
 * Supabase dashboard's table viewer — a leaked refresh token is a standing
 * "send email as you" capability until manually revoked at Google.
 *
 * Key must be a 32-byte value, base64-encoded, in OAUTH_TOKEN_ENCRYPTION_KEY.
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * Rotating this key invalidates every stored token — reconnect required.
 */

function getKey(): Buffer {
  const raw = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY is not set.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

// Stored format: base64(iv[12] || authTag[16] || ciphertext)
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptToken(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
