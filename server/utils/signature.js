import crypto from 'node:crypto';

// Verifies Meta's X-Hub-Signature-256 header ("sha256=<hex>") over the RAW request body with the app secret.
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!rawBody || !header || !appSecret || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(given, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
