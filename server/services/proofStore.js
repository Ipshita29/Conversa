// Stores payment screenshots on local disk under random names, outside any static folder. They are only ever returned through
// GET /api/payments/:id/proof, with a fixed content type, so an upload can never be served as a web page or script.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const dir = () => config.payments.proofDir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'proofs');

// The type comes from the file's own first bytes, not from what the browser claims.
export function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { type: 'image/png', ext: '.png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: '.jpg' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { type: 'image/webp', ext: '.webp' };
  return null;
}

export function checkImage(buf) {
  const kind = sniff(buf);
  if (!kind) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Upload a PNG, JPEG or WebP image.');
  if (buf.length > MAX_PROOF_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The image is larger than 5 MB.');
  return kind;
}

export const hashImage = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export async function saveProof(buf, originalName = null) {
  const kind = checkImage(buf);
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  const file = `${crypto.randomBytes(16).toString('hex')}${kind.ext}`;
  await fs.writeFile(path.join(dir(), file), buf, { mode: 0o600 });
  return { file, contentType: kind.type, size: buf.length, sha256: hashImage(buf), originalName: typeof originalName === 'string' ? originalName.slice(0, 120) : null };
}

export async function readProof(proof) {
  if (!proof?.file || !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(proof.file)) return null; // never build a path from anything else
  try { return await fs.readFile(path.join(dir(), proof.file)); } catch { return null; }
}
export const deleteProof = async (proof) => { if (proof?.file && /^[a-f0-9]{32}\.(png|jpg|webp)$/.test(proof.file)) await fs.rm(path.join(dir(), proof.file), { force: true }); };
