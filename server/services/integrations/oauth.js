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
function needApp(cfg) {
  const missing = [!cfg.meta.appId && 'META_APP_ID', !cfg.meta.appSecret && 'META_APP_SECRET', !hasEncryptionKey(cfg.encryptionKey) && 'ENCRYPTION_KEY'].filter(Boolean);
  if (missing.length) throw unavailable(`Connecting needs these environment variables on the server: ${missing.join(', ')}.`);
}
const form = (o) => new URLSearchParams(o).toString();

// ---- Instagram ------------------------------------------------------------------------------------------------------------------------
// Two logins, never mixed (see config.meta.instagram.mode):
//   unified          Facebook Login for Business + the configuration id. Authorize at facebook.com, exchange at graph.facebook.com (the META app id/secret),
//                    find the account with /me/assigned_instagram_accounts, message through graph.facebook.com.
//   instagram_login  Instagram's own OAuth at instagram.com with the INSTAGRAM app id/secret (a different pair from the Meta app's).
export const instagramRedirectUri = (cfg = config) => `${cfg.serverUrl}/api/integrations/instagram/oauth/callback`;
const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];
const MESSAGING_PERMISSIONS = ['instagram_manage_messages', 'instagram_business_manage_messages'];
const igApp = (cfg) => ({ id: cfg.meta.instagram.appId || cfg.meta.appId, secret: cfg.meta.instagram.appSecret || cfg.meta.appSecret });
const igMode = (cfg) => (cfg.meta.instagram.mode === 'unified' ? 'unified' : 'instagram_login');

// What signing in with Instagram needs from this server. The account's own token is NOT among them: that is what signing in produces.
export function instagramConnectReadiness(cfg = config) {
  const unified = igMode(cfg) === 'unified'; const app = unified ? { id: cfg.meta.appId, secret: cfg.meta.appSecret } : igApp(cfg);
  const missing = [!app.id && (unified ? 'META_APP_ID' : 'INSTAGRAM_APP_ID'), !app.secret && (unified ? 'META_APP_SECRET' : 'INSTAGRAM_APP_SECRET'), unified && !cfg.meta.instagram.loginConfigId && 'INSTAGRAM_LOGIN_CONFIG_ID',
    !hasEncryptionKey(cfg.encryptionKey) && 'ENCRYPTION_KEY', !cfg.serverUrl && 'SERVER_URL'].filter(Boolean);
  return { ready: missing.length === 0, missing, mode: unified ? 'unified' : 'instagram_login', app };
}
function needInstagram(cfg) {
  const r = instagramConnectReadiness(cfg);
  if (!r.ready) throw unavailable(`Connecting Instagram needs these environment variables on the server: ${r.missing.join(', ')}.`);
  return r.app;
}

export async function instagramStart(cfg = config) {
  const app = needInstagram(cfg);
  const state = await newState('instagram');
  const url = igMode(cfg) === 'unified'
    // No "scope": the configuration decides the permissions. override_default_response_type returns a code we exchange on the server.
    ? `https://www.facebook.com/${cfg.meta.graphVersion}/dialog/oauth?${form({ client_id: app.id, config_id: cfg.meta.instagram.loginConfigId, redirect_uri: instagramRedirectUri(cfg), response_type: 'code', override_default_response_type: 'true', state })}`
    : `https://www.instagram.com/oauth/authorize?${form({ client_id: app.id, redirect_uri: instagramRedirectUri(cfg), response_type: 'code', scope: IG_SCOPES.join(','), state })}`;
  return { url };
}

const metaJson = async (res, what) => {
  const b = await res.json().catch(() => null);
  if (!res.ok || b?.error || b?.error_message) throw new ApiError(502, 'META_REJECTED', `${what} rejected the request${(b?.error?.message || b?.error_message) ? `: ${b.error?.message ?? b.error_message}` : ''}.`);
  return b;
};

export async function instagramComplete({ code, state }, { fetchImpl = fetch, cfg = config } = {}) {
  const app = needInstagram(cfg);
  if (!code || !(await consumeState('instagram', state))) throw new ApiError(400, 'INVALID_STATE', 'This connection attempt expired or did not start here. Start again from Settings.');
  return igMode(cfg) === 'unified' ? unifiedComplete(code, app, fetchImpl, cfg) : instagramLoginComplete(code, app, fetchImpl, cfg);
}

async function unifiedComplete(code, app, fetchImpl, cfg) {
  const api = `https://graph.facebook.com/${cfg.meta.graphVersion}`;
  const tok = await metaJson(await fetchImpl(`${api}/oauth/access_token?${form({ client_id: app.id, client_secret: app.secret, redirect_uri: instagramRedirectUri(cfg), code })}`), 'Meta');
  const token = tok.access_token;
  if (!token) throw new ApiError(502, 'META_REJECTED', 'Meta did not return an access token.');
  // What the token can do and when it ends (expires_at 0 = a system-user token that never expires). Asked of Meta, not assumed.
  const dbg = (await metaJson(await fetchImpl(`${api}/debug_token?${form({ input_token: token, access_token: `${app.id}|${app.secret}` })}`), 'Meta'))?.data ?? {};
  if (dbg.is_valid === false) throw new ApiError(502, 'META_REJECTED', 'Meta says the access token it just issued is not valid.');
  const scopes = dbg.scopes ?? [];
  if (scopes.length && !scopes.some((x) => MESSAGING_PERMISSIONS.includes(x))) throw new ApiError(422, 'MISSING_PERMISSION', 'Instagram messaging permission (instagram_manage_messages) was not granted. In the Meta app, add it to the Instagram Login configuration, then connect again.');
  // The professional account(s) the owner shared. A Facebook Page is not involved in this login.
  const list = (await metaJson(await fetchImpl(`${api}/me/assigned_instagram_accounts?${form({ fields: 'id,username,name', access_token: token })}`), 'Meta')).data ?? [];
  const want = cfg.meta.instagram.businessAccountId;
  let account = (want && list.find((a) => String(a.id) === String(want))) || list[0];
  if (!account && want) { const r = await fetchImpl(`${api}/${want}?${form({ fields: 'id,username,name', access_token: token })}`); if (r.ok) account = await r.json(); }
  if (!account?.id) throw new ApiError(422, 'NO_ACCOUNT', 'No Instagram professional account was shared with Conversa. Connect again and choose the account on the Instagram step; it must be a business or creator account added to your Meta business portfolio.');
  const accountId = String(account.id);
  const expiresIn = dbg.expires_at ? Math.max(60, dbg.expires_at - Math.floor(Date.now() / 1000)) : null;
  await saveConnection('instagram', { accessToken: token, expiresInSeconds: expiresIn, accountId, accountLabel: account.username ? `@${account.username}` : (account.name ?? accountId), scopes, apiMode: 'unified' });
  // Subscribe this account's messages to this app (each shared account is subscribed individually, with this token).
  const sub = await graphPost(`${api}/${accountId}/subscribed_apps?${form({ subscribed_fields: 'messages,messaging_seen' })}`, token, {}, { fetchImpl });
  if (!sub.ok) log.warn('instagram', 'Connected, but subscribing the account to message webhooks failed; check the Instagram webhook fields in the app dashboard.', { status: sub.status });
  return { accountId, accountLabel: account.username ? `@${account.username}` : accountId, subscribed: sub.ok, extraAccounts: Math.max(0, list.length - 1) };
}

async function instagramLoginComplete(code, app, fetchImpl, cfg) {
  const short = await metaJson(await fetchImpl('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: app.id, client_secret: app.secret, grant_type: 'authorization_code', redirect_uri: instagramRedirectUri(cfg), code: String(code).replace(/#_$/, '') }) }), 'Instagram');
  const shortToken = short.access_token ?? short.data?.[0]?.access_token;
  if (!shortToken) throw new ApiError(502, 'META_REJECTED', 'Instagram did not return an access token.');
  const long = await metaJson(await fetchImpl(`https://graph.instagram.com/access_token?${form({ grant_type: 'ig_exchange_token', client_secret: app.secret, access_token: shortToken })}`), 'Instagram');
  const me = await metaJson(await fetchImpl(`https://graph.instagram.com/${cfg.meta.graphVersion}/me?${form({ fields: 'user_id,username,account_type', access_token: long.access_token })}`), 'Instagram');
  // Only professional accounts (business or creator) can use the messaging API; a personal account cannot.
  if (me.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(me.account_type).toUpperCase())) {
    throw new ApiError(422, 'NOT_PROFESSIONAL', 'This is a personal Instagram account. Switch it to a professional (business or creator) account in Instagram, then connect again.');
  }
  const accountId = String(me.user_id ?? me.id ?? short.user_id);
  await saveConnection('instagram', { accessToken: long.access_token, expiresInSeconds: long.expires_in ?? 5184000, accountId, accountLabel: me.username ? `@${me.username}` : accountId, scopes: IG_SCOPES, apiMode: 'instagram_login' });
  const sub = await graphPost(`https://graph.instagram.com/${cfg.meta.graphVersion}/${accountId}/subscribed_apps?${form({ subscribed_fields: 'messages,messaging_seen' })}`, long.access_token, {}, { fetchImpl });
  if (!sub.ok) log.warn('instagram', 'Connected, but subscribing the account to message webhooks failed; subscribe in the app dashboard.', { status: sub.status });
  return { accountId, accountLabel: me.username ? `@${me.username}` : accountId, subscribed: sub.ok };
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
