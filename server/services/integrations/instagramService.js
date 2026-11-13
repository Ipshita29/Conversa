// Instagram messaging (Instagram API with Instagram Login). Reports 'connected' ONLY after a successful credential check.
// Requires an Instagram professional account and Meta app permissions/review; none of that is automated here.
import { config } from '../../config/env.js';
import { graphGet, graphPost } from './graph.js';

export const CHANNEL = 'instagram';

// Two ways an account can be connected, with different hosts and tokens (never mixed):
//   unified          Facebook Login for Business: a system-user token, graph.facebook.com, the account id in the path.
//   instagram_login  Instagram's own OAuth: an Instagram user token, graph.instagram.com, "/me".
const modeOf = (cfg) => (cfg.meta.instagram.mode === 'unified' ? 'unified' : 'instagram_login');
export const apiBase = (cfg = config) => (modeOf(cfg) === 'unified' ? `https://graph.facebook.com/${cfg.meta.graphVersion}` : `https://graph.instagram.com/${cfg.meta.graphVersion}`);
const selfOf = (cfg) => (modeOf(cfg) === 'unified' ? cfg.meta.instagram.businessAccountId : 'me'); // the connected account, in this API's own words

export const missingConfig = (cfg = config) => [
  ...(cfg.meta.instagram.accessToken ? [] : ['INSTAGRAM_ACCESS_TOKEN']),
  ...(modeOf(cfg) === 'unified' && !cfg.meta.instagram.businessAccountId ? ['INSTAGRAM_BUSINESS_ACCOUNT_ID'] : []),
];
export const webhookMissing = (cfg = config) => [
  ...(cfg.meta.instagram.verifyToken ? [] : ['INSTAGRAM_VERIFY_TOKEN']),
  ...(cfg.meta.appSecret ? [] : ['META_APP_SECRET']),
];

// Meta's error codes, in the owner's words (the code is what Meta sends; the wording is ours).
export function explain(body, status) {
  const e = body?.error; const code = e?.code; const sub = e?.error_subcode;
  if (code === 190) return { reason: 'Instagram says the access token has expired or was revoked. Connect the account again in Settings.', code: 190 };
  if (code === 10 && [2534022, 2018278].includes(sub)) return { reason: 'Instagram only allows a reply within 24 hours of the customer’s last message. Reply once they write again.', code: 'WINDOW_CLOSED' };
  if (code === 10 || code === 200 || code === 230) return { reason: 'Instagram refused because this app does not have permission to message here. Check that instagram_manage_messages is granted and the account has the app’s tester/role.', code };
  if (code === 551 || sub === 1545041) return { reason: 'This person can no longer be messaged (they blocked the account or are unavailable).', code };
  if (code === 100 && /media|attachment/i.test(e?.message ?? '')) return { reason: 'Instagram does not support that kind of attachment.', code };
  return { reason: status ? `Instagram refused the message${e?.message ? `: ${e.message}` : ` (HTTP ${status})`}.` : 'Could not reach Instagram.', code: code ?? null };
}

export async function checkStatus(deps = {}, cfg = config) {
  const missing = missingConfig(cfg);
  const base = { channel: CHANNEL, accountLabel: null, lastSyncAt: null, webhookConfigured: webhookMissing(cfg).length === 0 };
  if (missing.length) return { ...base, status: 'unavailable', statusReason: `Not configured. Missing environment variables: ${missing.join(', ')}.` };

  const r = await graphGet(`${apiBase(cfg)}/${selfOf(cfg)}?fields=username`, cfg.meta.instagram.accessToken, deps);
  if (!r.ok) return { ...base, status: 'unavailable', statusReason: r.status ? (r.body?.error?.code === 190 ? explain(r.body, r.status).reason : `Meta rejected the credentials (HTTP ${r.status}).`) : `Could not reach Meta (${r.error}).` };
  const wh = webhookMissing(cfg);
  return { ...base, status: 'connected', statusReason: wh.length ? `Credentials verified. Incoming messages are disabled until ${wh.join(', ')} is set.` : 'Credentials verified with the Instagram API.', accountLabel: r.body?.username ? `@${r.body.username}` : null };
}

export function verifyChallenge(query, cfg = config) {
  const expected = cfg.meta.instagram.verifyToken;
  if (!expected) return { ok: false, status: 503 };
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected && query['hub.challenge'] !== undefined) return { ok: true, challenge: String(query['hub.challenge']) };
  return { ok: false, status: 403 };
}

// The events of one webhook entry. Instagram Login delivers them in entry[].messaging[]; Unified Login / Facebook Login for Business wrap the same
// event as entry[].changes[] = { field, value }. Both are read, so either setup works.
const events = (entry, field) => [...(entry.messaging ?? []), ...(entry.changes ?? []).filter((c) => c?.field === field && c.value && typeof c.value === 'object').map((c) => c.value)];

// Payload: entry[].messaging[] = { sender:{id}, recipient:{id}, timestamp, message:{mid,text,attachments[],is_echo?} }.
// A picture arrives as attachments[{ type: 'image', payload: { url } }]; the URL is short-lived and is downloaded on receipt.
export function parseWebhook(body) {
  const out = [];
  if (!body || body.object !== 'instagram' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const ev of events(entry, 'messages')) {
      const m = ev.message;
      if (!m?.mid || !ev.sender?.id || m.is_echo) continue; // ignore our own outgoing messages
      const image = (m.attachments ?? []).find((a) => a?.type === 'image' && typeof a.payload?.url === 'string');
      out.push({
        channel: CHANNEL, externalId: String(m.mid), contactId: String(ev.sender.id), contactName: null,
        messageType: image ? 'image' : m.text !== undefined ? 'text' : m.attachments?.length ? String(m.attachments[0]?.type ?? 'unsupported') : 'unsupported', text: m.text ?? null,
        ...(image ? { mediaUrl: image.payload.url } : {}),
        receivedAt: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date(),
      });
    }
  }
  return out;
}

// The customer has seen a message we sent: entry[].messaging[].read = { mid }.
export function parseStatuses(body) {
  const out = [];
  if (!body || body.object !== 'instagram' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) for (const ev of events(entry, 'messaging_seen')) {
    if (ev.read?.mid) out.push({ channel: CHANNEL, externalId: String(ev.read.mid), status: 'read', at: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date(), error: null });
  }
  return out;
}

// The customer's name and handle, where Meta permits it (the user must have messaged us). Null on any problem: the conversation works without it.
export async function fetchProfile(igsid, deps = {}, cfg = config) {
  const token = cfg.meta.instagram.accessToken;
  if (!token || !/^\d{5,25}$/.test(String(igsid))) return null;
  const r = await graphGet(`${apiBase(cfg)}/${igsid}?fields=name,username`, token, deps);
  return r.ok ? { name: r.body?.name ?? (r.body?.username ? `@${r.body.username}` : null), username: r.body?.username ?? null } : null;
}

// Downloads a picture a customer sent in a DM from Meta's CDN (https only, Meta hosts only, size-capped). Null on any problem.
export async function downloadMediaUrl(url, { fetchImpl = fetch, timeoutMs = 10000, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]*(facebook|fbcdn|fbsbx|cdninstagram|instagram)\.(com|net)\//i.test(url)) return null;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= maxBytes ? buf : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// Sends a plain text message to an Instagram-scoped user id (only possible inside Meta's messaging window for that customer).
export async function sendText(to, text, deps = {}, cfg = config) {
  const missing = missingConfig(cfg);
  if (missing.length) return { ok: false, reason: `Not configured. Missing environment variables: ${missing.join(', ')}.` };
  const r = await graphPost(`${apiBase(cfg)}/${selfOf(cfg)}/messages`, cfg.meta.instagram.accessToken, { recipient: { id: to }, message: { text } }, deps);
  if (r.ok) return { ok: true, externalId: r.body?.message_id ?? null };
  return { ok: false, ...(r.status ? explain(r.body, r.status) : { reason: `Could not reach Instagram (${r.error}).` }) };
}
