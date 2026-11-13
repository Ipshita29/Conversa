import crypto from 'node:crypto';
import { config } from '../config/env.js';

// AES-256-GCM for the long-lived Meta tokens kept in the database. The key is derived from ENCRYPTION_KEY; the stored form is "v1.<iv>.<tag>.<data>"
// (base64url), so a changed or truncated value fails to decrypt instead of returning garbage.
const keyOf = (secret) => crypto.createHash('sha256').update(String(secret)).digest();
export const hasEncryptionKey = (secret = config.encryptionKey) => typeof secret === 'string' && secret.length >= 32;

export function encrypt(plain, secret = config.encryptionKey) {
  if (!hasEncryptionKey(secret)) throw new Error('ENCRYPTION_KEY is not configured (at least 32 characters), so credentials cannot be stored.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(token, secret = config.encryptionKey) {
  const [v, iv, tag, data] = String(token ?? '').split('.');
  if (v !== 'v1' || !iv || !tag || !data || !hasEncryptionKey(secret)) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; } // wrong key or tampered value
}
