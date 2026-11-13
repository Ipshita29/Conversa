// Connecting an account the official way: Instagram Business Login (OAuth) and WhatsApp Embedded Signup. The owner never pastes a token: Meta hands
// this server a short-lived CODE, which is exchanged here (with the app secret, server-side only) for a token that is stored encrypted.
// Every network call takes an injectable fetch, so the whole flow is tested without Meta.
import { config } from '../../config/env.js';
import { ApiError } from '../../utils/errors.js';
import { log } from '../../utils/log.js';
import { hasEncryptionKey } from '../../utils/crypto.js';
import { consumeState, newState, saveConnection } from './credentials.js';
import { graphPost } from './graph.js';

const unavailable = (message) => new ApiError(503, 'INTEGRATION_UNAVAILABLE', message);
const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];

function needApp(cfg) {
  const missing = [!cfg.meta.appId && 'META_APP_ID', !cfg.meta.appSecret && 'META_APP_SECRET', !hasEncryptionKey(cfg.encryptionKey) && 'ENCRYPTION_KEY'].filter(Boolean);
  if (missing.length) throw unavailable(`Connecting needs these environment variables on the server: ${missing.join(', ')}.`);
}
const form = (o) => new URLSearchParams(o).toString();

// ---- Instagram (API with Instagram Login) ------------------------------------------------------------------------------------------------
export const instagramRedirectUri = (cfg = config) => `${cfg.serverUrl}/api/integrations/instagram/oauth/callback`;

export async function instagramStart(cfg = config) {
  needApp(cfg);
  if (!cfg.serverUrl) throw unavailable('SERVER_URL is not set, so the OAuth callback address is unknown.');
  const state = await newState('instagram');
  const url = `https://www.instagram.com/oauth/authorize?${form({ client_id: cfg.meta.appId, redirect_uri: instagramRedirectUri(cfg), response_type: 'code', scope: IG_SCOPES.join(','), state })}`;
  return { url };
}

export async function instagramComplete({ code, state }, { fetchImpl = fetch, cfg = config } = {}) {
  needApp(cfg);
  if (!code || !(await consumeState('instagram', state))) throw new ApiError(400, 'INVALID_STATE', 'This connection attempt expired or did not start here. Start again from Settings.');
  const json = async (res) => { const b = await res.json().catch(() => null); if (!res.ok || b?.error || b?.error_message) throw new ApiError(502, 'META_REJECTED', `Instagram rejected the request${(b?.error?.message || b?.error_message) ? `: ${b.error?.message ?? b.error_message}` : ''}.`); return b; };
  const short = await json(await fetchImpl('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, grant_type: 'authorization_code', redirect_uri: instagramRedirectUri(cfg), code: String(code).replace(/#_$/, '') }) }));
  const shortToken = short.access_token ?? short.data?.[0]?.access_token;
  if (!shortToken) throw new ApiError(502, 'META_REJECTED', 'Instagram did not return an access token.');
  const long = await json(await fetchImpl(`https://graph.instagram.com/access_token?${form({ grant_type: 'ig_exchange_token', client_secret: cfg.meta.appSecret, access_token: shortToken })}`));
  const me = await json(await fetchImpl(`https://graph.instagram.com/${cfg.meta.graphVersion}/me?${form({ fields: 'user_id,username,account_type', access_token: long.access_token })}`));
  // Only professional accounts (business or creator) can use the messaging API; a personal account cannot.
  if (me.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(me.account_type).toUpperCase())) {
    throw new ApiError(422, 'NOT_PROFESSIONAL', 'This is a personal Instagram account. Switch it to a professional (business or creator) account in Instagram, then connect again.');
  }
  const accountId = String(me.user_id ?? me.id ?? short.user_id);
  await saveConnection('instagram', { accessToken: long.access_token, expiresInSeconds: long.expires_in ?? 5184000, accountId, accountLabel: me.username ? `@${me.username}` : accountId, scopes: IG_SCOPES });
  // Subscribe this account to message webhooks (best effort: the same can be done once in the app dashboard).
  const sub = await graphPost(`https://graph.instagram.com/${cfg.meta.graphVersion}/${accountId}/subscribed_apps?${form({ subscribed_fields: 'messages,messaging_seen' })}`, long.access_token, {}, { fetchImpl });
  if (!sub.ok) log.warn('instagram', 'Connected, but subscribing the account to message webhooks failed; subscribe in the app dashboard.', { status: sub.status });
  return { accountId, accountLabel: me.username ? `@${me.username}` : accountId };
}

// ---- WhatsApp (Embedded Signup) ------------------------------------------------------------------------------------------------------------
export function whatsappSignupConfig(cfg = config) {
  const ready = Boolean(cfg.meta.appId && cfg.meta.appSecret && cfg.meta.whatsapp.embeddedSignupConfigId && hasEncryptionKey(cfg.encryptionKey));
  return { ready, appId: cfg.meta.appId || null, configId: cfg.meta.whatsapp.embeddedSignupConfigId || null, graphVersion: cfg.meta.graphVersion,
    missing: [!cfg.meta.appId && 'META_APP_ID', !cfg.meta.appSecret && 'META_APP_SECRET', !cfg.meta.whatsapp.embeddedSignupConfigId && 'WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID', !hasEncryptionKey(cfg.encryptionKey) && 'ENCRYPTION_KEY'].filter(Boolean) };
}

// `code` comes from FB.login (valid 30 seconds); wabaId / phoneNumberId from the WA_EMBEDDED_SIGNUP session event. All three are checked against Meta.
export async function whatsappComplete({ code, wabaId, phoneNumberId }, { fetchImpl = fetch, cfg = config } = {}) {
  const sc = whatsappSignupConfig(cfg);
  if (!sc.ready) throw unavailable(`WhatsApp sign-up needs these environment variables on the server: ${sc.missing.join(', ')}.`);
  if (!code || !/^\d{5,25}$/.test(String(wabaId ?? '')) || !/^\d{5,25}$/.test(String(phoneNumberId ?? ''))) throw new ApiError(422, 'VALIDATION_ERROR', 'The sign-up result is incomplete (code, WhatsApp Business Account id and phone number id are required).');
  const tokenRes = await fetchImpl(`https://graph.facebook.com/${cfg.meta.graphVersion}/oauth/access_token?${form({ client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, code })}`);
  const tok = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tok?.access_token) throw new ApiError(502, 'META_REJECTED', `Meta rejected the sign-up code${tok?.error?.message ? `: ${tok.error.message}` : ''}. The code is only valid for 30 seconds; try again.`);
  const api = `https://graph.facebook.com/${cfg.meta.graphVersion}`;
  const num = await fetchImpl(`${api}/${phoneNumberId}?${form({ fields: 'display_phone_number,verified_name' })}`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const info = await num.json().catch(() => null);
  if (!num.ok) throw new ApiError(502, 'META_REJECTED', 'The token cannot read that WhatsApp phone number, so it was not connected.');
  // Route this business's incoming messages and statuses to this app (idempotent).
  const sub = await graphPost(`${api}/${wabaId}/subscribed_apps`, tok.access_token, {}, { fetchImpl });
  if (!sub.ok) throw new ApiError(502, 'META_REJECTED', 'Connected, but Meta would not subscribe this app to the account\'s webhooks. Check the app\'s whatsapp_business_messaging permission.');
  await saveConnection('whatsapp', { accessToken: tok.access_token, expiresInSeconds: tok.expires_in ?? null, accountId: String(phoneNumberId), businessAccountId: String(wabaId), accountLabel: info?.display_phone_number ?? info?.verified_name ?? String(phoneNumberId), scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] });
  return { accountId: String(phoneNumberId), accountLabel: info?.display_phone_number ?? info?.verified_name ?? String(phoneNumberId) };
}
