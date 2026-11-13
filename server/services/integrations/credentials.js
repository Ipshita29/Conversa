// The one place that knows where a channel's credentials live: an encrypted database record (connected through OAuth / Embedded Signup), else the
// environment variables. Everything that talks to Meta asks for `resolveConfig()` and gets a config object of the same shape as `config`.
import crypto from 'node:crypto';
import Integration from '../../models/Integration.js';
import { config } from '../../config/env.js';
import { decrypt, encrypt } from '../../utils/crypto.js';
import { isDbReady } from '../../config/db.js';

const REFRESH_WITHIN_MS = 10 * 24 * 3600000; // Instagram tokens last 60 days; refresh once fewer than 10 are left
const MIN_AGE_MS = 24 * 3600000;             // ...and Meta only refreshes a token that is at least a day old
export const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

export async function getRecord(channel) {
  return isDbReady() ? Integration.findOne({ channel }) : null;
}
const expired = (r, now = new Date()) => Boolean(r?.tokenExpiresAt && r.tokenExpiresAt <= now);

// A config in which the stored (decrypted) tokens replace the environment ones for every connected channel.
export async function resolveConfig(base = config) {
  const cfg = { ...base, meta: { ...base.meta, whatsapp: { ...base.meta.whatsapp }, instagram: { ...base.meta.instagram } } };
  if (!isDbReady()) return cfg;
  for (const r of await Integration.find({ status: { $in: ['connected', 'needs_attention'] } })) {
    if (expired(r)) continue;
    const token = decrypt(r.accessTokenEnc);
    if (!token) continue;
    if (r.channel === 'whatsapp') Object.assign(cfg.meta.whatsapp, { accessToken: token, ...(r.accountId ? { phoneNumberId: r.accountId } : {}), ...(r.businessAccountId ? { businessAccountId: r.businessAccountId } : {}) });
    if (r.channel === 'instagram') Object.assign(cfg.meta.instagram, { accessToken: token, mode: r.apiMode ?? 'instagram_login', ...(r.accountId ? { businessAccountId: r.accountId } : {}) });
  }
  return cfg;
}

export async function saveConnection(channel, { accessToken, expiresInSeconds = null, accountId, accountLabel, businessAccountId = null, scopes = [], apiMode = null }) {
  const now = new Date();
  return Integration.findOneAndUpdate({ channel }, { $set: {
    status: 'connected', statusReason: null, apiMode, accountId: accountId ?? null, accountLabel: accountLabel ?? null, businessAccountId, scopes,
    accessTokenEnc: encrypt(accessToken), tokenIssuedAt: now, lastRefreshAt: now, connectedAt: now,
    tokenExpiresAt: expiresInSeconds ? new Date(now.getTime() + expiresInSeconds * 1000) : null, oauthStateHash: null, oauthStateExpires: null,
  } }, { upsert: true, new: true });
}

// Disconnecting forgets the token. The messages already received stay in the Inbox.
export async function disconnect(channel) {
  return Integration.findOneAndUpdate({ channel }, { $set: { status: 'disconnected', statusReason: null, accessTokenEnc: null, tokenExpiresAt: null, oauthStateHash: null, oauthStateExpires: null } }, { new: true });
}

export async function markNeedsAttention(channel, reason) {
  await Integration.updateOne({ channel }, { $set: { status: 'needs_attention', statusReason: String(reason).slice(0, 300) } });
}

// CSRF state for the OAuth round trip: only a hash is stored, and it can be used once within ten minutes.
export async function newState(channel) {
  const state = crypto.randomBytes(24).toString('base64url');
  await Integration.findOneAndUpdate({ channel }, { $set: { status: 'connecting', oauthStateHash: sha(state), oauthStateExpires: new Date(Date.now() + 10 * 60000) } }, { upsert: true });
  return state;
}
export async function consumeState(channel, state) {
  const r = await Integration.findOneAndUpdate({ channel, oauthStateHash: sha(state ?? ''), oauthStateExpires: { $gt: new Date() } }, { $set: { oauthStateHash: null, oauthStateExpires: null } });
  return Boolean(r);
}

// What Settings shows for one channel: the stored record, or "configured through the environment", or nothing. Never a token.
export function describe(channel, record, cfg = config, now = new Date()) {
  const env = channel === 'whatsapp' ? Boolean(cfg.meta.whatsapp.accessToken && cfg.meta.whatsapp.phoneNumberId) : Boolean(cfg.meta.instagram.accessToken);
  // A sign-in that was started and never finished (the owner closed the tab) is not "connecting" for ever: after its ten minutes it is simply not connected.
  const stale = record?.status === 'connecting' && (!record.oauthStateExpires || record.oauthStateExpires <= now) && !record.accessTokenEnc;
  if (record && record.status !== 'disconnected' && !stale) {
    const status = expired(record, now) ? 'expired' : record.status;
    return { status, accountLabel: record.accountLabel, statusReason: status === 'expired' ? 'The access token has expired. Connect the account again.' : record.statusReason, source: 'oauth', expiresAt: record.tokenExpiresAt?.toISOString?.() ?? null };
  }
  return { status: env ? 'env' : record ? 'disconnected' : 'not_connected', accountLabel: null, statusReason: null, source: env ? 'environment' : null, expiresAt: null };
}

// Instagram long-lived tokens must be refreshed before they lapse (each refresh adds 60 days). Called on a timer and before sending.
export async function refreshInstagramIfDue({ fetchImpl = fetch, now = new Date() } = {}) {
  const r = await getRecord('instagram');
  if (!r || r.status === 'disconnected' || !r.accessTokenEnc) return { refreshed: false, reason: 'not_connected' };
  if (r.apiMode === 'unified') { // a business system-user token: Meta offers no refresh. Most never expire; one that does must be reconnected
    if (r.tokenExpiresAt && r.tokenExpiresAt.getTime() - now.getTime() < 3 * 24 * 3600000 && r.status === 'connected') await markNeedsAttention('instagram', 'The access token is about to expire and cannot be renewed automatically. Connect the account again.');
    return { refreshed: false, reason: 'unified' };
  }
  if (expired(r, now)) { await Integration.updateOne({ channel: 'instagram' }, { $set: { status: 'expired', statusReason: 'The access token has expired. Connect the account again.' } }); return { refreshed: false, reason: 'expired' }; }
  if (!r.tokenExpiresAt || r.tokenExpiresAt.getTime() - now.getTime() > REFRESH_WITHIN_MS) return { refreshed: false, reason: 'not_due' };
  if (r.tokenIssuedAt && now.getTime() - r.tokenIssuedAt.getTime() < MIN_AGE_MS) return { refreshed: false, reason: 'too_new' };
  const token = decrypt(r.accessTokenEnc);
  if (!token) { await markNeedsAttention('instagram', 'The stored token could not be read. Connect the account again.'); return { refreshed: false, reason: 'unreadable' }; }
  try {
    const res = await fetchImpl(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) { await markNeedsAttention('instagram', `Meta refused to refresh the token${body?.error?.message ? `: ${body.error.message}` : ''}. Connect the account again.`); return { refreshed: false, reason: 'refused' }; }
    await Integration.updateOne({ channel: 'instagram' }, { $set: { accessTokenEnc: encrypt(body.access_token), tokenIssuedAt: now, lastRefreshAt: now, tokenExpiresAt: new Date(now.getTime() + (body.expires_in ?? 5184000) * 1000), status: 'connected', statusReason: null } });
    return { refreshed: true };
  } catch { return { refreshed: false, reason: 'network' }; } // try again on the next tick; the token is still valid
}
