// The Settings diagnostics and the "Test connection" action. Every step asks the real thing (Meta, our own public address, the database); nothing is judged
// from whether an environment variable is merely filled in. Tokens and secrets are used here and never returned.
import { config } from '../../config/env.js';
import Message from '../../models/Message.js';
import ChannelDiag from '../../models/ChannelDiag.js';
import { graphGet, graphBase } from './graph.js';
import { resolveConfig } from './credentials.js';

const metaWhy = (r) => r.body?.error?.message ? String(r.body.error.message).slice(0, 220) : r.status ? `HTTP ${r.status}` : `could not reach Meta (${r.error})`;
// What a refusal from Meta means for the owner: an expired/revoked token, missing permission, or an id that does not exist or is not shared with this token.
export function explain(r) {
  const code = r.body?.error?.code; const sub = r.body?.error?.error_subcode;
  if (r.status === 401 || code === 190) return sub === 463 || /expired/i.test(r.body?.error?.message ?? '') ? 'The access token has expired. Create a permanent System User token and set WHATSAPP_ACCESS_TOKEN.' : 'The access token is invalid or was revoked. Create a new System User token and set WHATSAPP_ACCESS_TOKEN.';
  if (r.status === 403 || code === 10 || code === 200 || code === 299) return 'The token is valid but lacks permission. In Business Settings, give the System User full control of the WhatsApp account and the app, and make sure whatsapp_business_messaging and whatsapp_business_management were selected when generating the token.';
  if (code === 100 || r.status === 400 || r.status === 404) return 'Meta does not recognise that id for this token. Check WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_BUSINESS_ACCOUNT_ID, and that the System User has both assigned.';
  if (r.status === 0) return `Could not reach Meta (${r.error}).`;
  return `Meta answered HTTP ${r.status}.`;
}

export async function lastActivity(channel) {
  const q = { channel, isDemo: { $ne: true } };
  const [inbound, outbound, pic, diag] = await Promise.all([
    Message.findOne({ ...q, direction: 'inbound' }).sort({ receivedAt: -1 }).select('receivedAt').lean(),
    Message.findOne({ ...q, direction: 'outbound', 'delivery.mode': 'real' }).sort({ receivedAt: -1 }).select('receivedAt delivery').lean(),
    Message.findOne({ ...q, direction: 'inbound', messageType: 'image' }).sort({ receivedAt: -1 }).select('receivedAt attachment media').lean(),
    ChannelDiag.findOne({ channel }).lean(),
  ]);
  return {
    lastIncomingAt: inbound?.receivedAt ?? null,
    lastOutgoingAt: outbound?.receivedAt ?? null,
    webhook: { verifiedAt: diag?.verifiedAt ?? null, lastReceivedAt: diag?.lastReceivedAt ?? null, lastError: diag?.lastError ?? null },
    media: pic ? { lastPictureAt: pic.receivedAt, state: pic.attachment ? 'downloaded' : (pic.media?.state ?? 'failed'), error: pic.attachment ? null : pic.media?.error ?? null } : { lastPictureAt: null, state: 'none', error: null },
  };
}

// Runs the real checks for WhatsApp. Each step: { id, label, ok: true | false | null (could not tell), detail }.
export async function testWhatsApp(deps = {}) {
  const cfg = await resolveConfig(); const w = cfg.meta.whatsapp; const steps = []; const add = (id, label, ok, detail) => steps.push({ id, label, ok, detail });
  const missing = [!w.accessToken && 'access token', !w.phoneNumberId && 'phone number id'].filter(Boolean);
  if (missing.length) { add('credentials', 'Credentials present', false, `Missing: ${missing.join(', ')}.`); return { ok: false, steps }; }
  add('credentials', 'Credentials present', true, 'An access token and a phone number id are configured.');

  const ph = await graphGet(`${graphBase()}/${encodeURIComponent(w.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,platform_type`, w.accessToken, deps);
  let tokenOk = ph.ok;
  add('token', 'Access token accepted by Meta', ph.ok, ph.ok ? 'Meta accepted the token.' : `${explain(ph)} (Meta: ${metaWhy(ph)})`);
  add('number', 'Phone number', ph.ok ? true : null, ph.ok ? `${ph.body?.display_phone_number ?? 'unknown number'}${ph.body?.verified_name ? ` (${ph.body.verified_name})` : ''}, ${ph.body?.platform_type ?? 'Cloud API'}. Customers must message this number.` : 'Could not be read because the token was refused.');

  // Permissions and lifetime of the token, as Meta records them (needs the app's own credentials to ask).
  if (tokenOk && cfg.meta.appId && cfg.meta.appSecret) {
    const dbg = await graphGet(`${graphBase()}/debug_token?input_token=${encodeURIComponent(w.accessToken)}`, `${cfg.meta.appId}|${cfg.meta.appSecret}`, deps);
    const d = dbg.body?.data; const scopes = d?.scopes ?? [];
    const need = ['whatsapp_business_messaging', 'whatsapp_business_management'].filter((x) => !scopes.includes(x));
    const exp = d?.expires_at ? new Date(d.expires_at * 1000) : null;
    add('permissions', 'Token permissions', dbg.ok && d ? need.length === 0 : null, !dbg.ok || !d ? `Could not read the token's details (${metaWhy(dbg)}).` : need.length ? `Missing permission: ${need.join(', ')}. Generate the token again with them selected.` : `whatsapp_business_messaging and whatsapp_business_management granted. ${exp ? `Expires ${exp.toISOString().slice(0, 10)}.` : 'Does not expire.'}`);
  }
  if (w.businessAccountId && tokenOk) {
    const nums = await graphGet(`${graphBase()}/${encodeURIComponent(w.businessAccountId)}/phone_numbers?fields=id,display_phone_number`, w.accessToken, deps);
    const has = nums.ok && (nums.body?.data ?? []).some((n) => String(n.id) === String(w.phoneNumberId));
    add('waba', 'Phone number belongs to the WhatsApp Business Account', nums.ok ? has : false, !nums.ok ? explain(nums) : has ? 'The configured phone number id is on this account.' : 'WHATSAPP_PHONE_NUMBER_ID is not a number of WHATSAPP_BUSINESS_ACCOUNT_ID. Check both ids.');
  }
  if (w.businessAccountId && tokenOk) {
    const sub = await graphGet(`${graphBase()}/${encodeURIComponent(w.businessAccountId)}/subscribed_apps`, w.accessToken, deps);
    const mine = sub.ok && (sub.body?.data ?? []).some((a) => String(a.whatsapp_business_api_data?.id ?? a.id) === String(cfg.meta.appId));
    add('subscription', 'App subscribed to this WhatsApp account', sub.ok ? mine : null, !sub.ok ? `Could not read it: ${metaWhy(sub)}.` : mine ? 'Conversa\'s app receives this account\'s messages.' : 'Conversa\'s app is NOT subscribed to this WhatsApp Business Account, so Meta sends it nothing. Subscribe it (WhatsApp → Configuration → Webhook fields: messages).');
  } else add('subscription', 'App subscribed to this WhatsApp account', null, tokenOk ? 'WHATSAPP_BUSINESS_ACCOUNT_ID is not set.' : 'Skipped: the token was refused.');

  // Is OUR public address reachable? A wrong token must get a 403 from this very server; anything else means Meta cannot get in either.
  const url = config.serverUrl ? `${config.serverUrl}/api/webhooks/whatsapp` : null;
  if (!url) add('public_url', 'Public webhook address answers', false, 'SERVER_URL is not set.');
  else {
    try {
      const r = await (deps.fetchImpl ?? fetch)(`${url}?hub.mode=subscribe&hub.verify_token=conversa-self-check&hub.challenge=x`, { signal: AbortSignal.timeout(8000) });
      add('public_url', 'Public webhook address answers', r.status === 403, r.status === 403 ? `${url} reaches this server.` : `${url} answered HTTP ${r.status}, not this server's webhook.`);
    } catch (e) { add('public_url', 'Public webhook address answers', false, `${url} cannot be reached (${e.cause?.code ?? e.name}). If this is a temporary tunnel it has changed or stopped: update SERVER_URL and Meta's callback URL.`); }
  }

  // What Meta itself has registered as the callback. Reading it needs app-level access, which Meta does not always grant.
  if (cfg.meta.appId && cfg.meta.appSecret && url) {
    const sub = await graphGet(`${graphBase()}/${encodeURIComponent(cfg.meta.appId)}/subscriptions?access_token=${encodeURIComponent(`${cfg.meta.appId}|${cfg.meta.appSecret}`)}`, '', deps);
    const reg = sub.ok ? (sub.body?.data ?? []).find((x) => x.object === 'whatsapp_business_account') : null;
    add('callback', 'Meta\'s callback URL matches', sub.ok ? Boolean(reg) && reg.callback_url === url : null, !sub.ok ? `Meta did not let this server read it (${metaWhy(sub)}). Check WhatsApp → Configuration in the Meta dashboard: it must be ${url}.` : !reg ? 'Meta has no WhatsApp callback registered.' : reg.callback_url === url ? 'Meta delivers to this address.' : `Meta delivers to ${reg.callback_url}, not ${url}. Change it in the Meta dashboard.`);
  }
  const d = await ChannelDiag.findOne({ channel: 'whatsapp' }).lean();
  add('handshake', 'Meta has completed the webhook verification', d?.verifiedAt ? true : null, d?.verifiedAt ? `Last verified ${new Date(d.verifiedAt).toISOString()}.` : 'Meta has not yet called the verification (it does this when you save the callback URL in the dashboard).');
  return { ok: steps.every((s) => s.ok !== false), steps };
}

// Points Meta at THIS server's public address (SERVER_URL) and subscribes the app to the WhatsApp account. Needed after the address changes (a temporary
// tunnel restarts). Uses the app's own credentials and the WhatsApp token; nothing secret leaves the server except to Meta.
export async function registerWhatsAppWebhook(deps = {}) {
  const cfg = await resolveConfig(); const w = cfg.meta.whatsapp; const steps = []; const add = (id, label, ok, detail) => steps.push({ id, label, ok, detail });
  const url = config.serverUrl ? `${config.serverUrl}/api/webhooks/whatsapp` : null;
  if (!url || !cfg.meta.appId || !cfg.meta.appSecret || !w.verifyToken) { add('inputs', 'Settings needed', false, 'SERVER_URL, META_APP_ID, META_APP_SECRET and the verify token must be set.'); return { ok: false, steps }; }
  const f = deps.fetchImpl ?? fetch;
  try {
    const r = await f(`${graphBase()}/${encodeURIComponent(cfg.meta.appId)}/subscriptions`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ object: 'whatsapp_business_account', callback_url: url, fields: 'messages', verify_token: w.verifyToken, access_token: `${cfg.meta.appId}|${cfg.meta.appSecret}` }), signal: AbortSignal.timeout(15000) });
    const b = await r.json().catch(() => ({}));
    add('callback', 'Callback address registered with Meta', r.ok && b.success === true, r.ok ? `Meta now delivers to ${url} (it verified the address).` : `Meta refused: ${b.error?.message ?? `HTTP ${r.status}`}`);
  } catch (e) { add('callback', 'Callback address registered with Meta', false, `Could not reach Meta (${e.name}).`); }
  if (w.businessAccountId && w.accessToken) {
    const r = await (deps.fetchImpl ? deps.fetchImpl(`${graphBase()}/${encodeURIComponent(w.businessAccountId)}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${w.accessToken}` } }).then(async (x) => ({ ok: x.ok, status: x.status, body: await x.json().catch(() => null) })) : fetch(`${graphBase()}/${encodeURIComponent(w.businessAccountId)}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${w.accessToken}` }, signal: AbortSignal.timeout(15000) }).then(async (x) => ({ ok: x.ok, status: x.status, body: await x.json().catch(() => null) })).catch(() => ({ ok: false, status: 0, error: 'network' })));
    add('subscription', 'App subscribed to the WhatsApp account', r.ok && r.body?.success === true, r.ok ? 'Messages from this account are delivered to Conversa.' : explain(r));
  }
  return { ok: steps.every((s) => s.ok), steps };
}
