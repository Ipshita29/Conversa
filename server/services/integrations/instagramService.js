// Instagram messaging (Instagram API with Instagram Login). Reports 'connected' ONLY after a successful credential check.
// Requires an Instagram professional account and Meta app permissions/review; none of that is automated here.
import { config } from '../../config/env.js';
import { graphGet, graphPost } from './graph.js';

export const CHANNEL = 'instagram';

export const missingConfig = (cfg = config) => (cfg.meta.instagram.accessToken ? [] : ['INSTAGRAM_ACCESS_TOKEN']);
export const webhookMissing = (cfg = config) => [
  ...(cfg.meta.instagram.verifyToken ? [] : ['INSTAGRAM_VERIFY_TOKEN']),
  ...(cfg.meta.appSecret ? [] : ['META_APP_SECRET']),
];

export async function checkStatus(deps = {}, cfg = config) {
  const missing = missingConfig(cfg);
  const base = { channel: CHANNEL, accountLabel: null, lastSyncAt: null, webhookConfigured: webhookMissing(cfg).length === 0 };
  if (missing.length) return { ...base, status: 'unavailable', statusReason: `Not configured. Missing environment variables: ${missing.join(', ')}.` };

  const r = await graphGet(`https://graph.instagram.com/${config.meta.graphVersion}/me?fields=username`, cfg.meta.instagram.accessToken, deps);
  if (!r.ok) return { ...base, status: 'unavailable', statusReason: r.status ? `Meta rejected the credentials (HTTP ${r.status}).` : `Could not reach Meta (${r.error}).` };
  const wh = webhookMissing(cfg);
  return { ...base, status: 'connected', statusReason: wh.length ? `Credentials verified. Incoming messages are disabled until ${wh.join(', ')} is set.` : 'Credentials verified with the Instagram API.', accountLabel: r.body?.username ? `@${r.body.username}` : null };
}

export function verifyChallenge(query, cfg = config) {
  const expected = cfg.meta.instagram.verifyToken;
  if (!expected) return { ok: false, status: 503 };
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected && query['hub.challenge'] !== undefined) return { ok: true, challenge: String(query['hub.challenge']) };
  return { ok: false, status: 403 };
}

// Payload: entry[].messaging[] = { sender:{id}, recipient:{id}, timestamp, message:{mid,text,attachments[],is_echo?} }.
// A picture arrives as attachments[{ type: 'image', payload: { url } }]; the URL is short-lived and is downloaded on receipt.
export function parseWebhook(body) {
  const out = [];
  if (!body || body.object !== 'instagram' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const ev of entry.messaging ?? []) {
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
  for (const entry of body.entry) for (const ev of entry.messaging ?? []) {
    if (ev.read?.mid) out.push({ channel: CHANNEL, externalId: String(ev.read.mid), status: 'read', at: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date(), error: null });
  }
  return out;
}

// The customer's name and handle, where Meta permits it (the user must have messaged us). Null on any problem: the conversation works without it.
export async function fetchProfile(igsid, deps = {}, cfg = config) {
  const token = cfg.meta.instagram.accessToken;
  if (!token || !/^\d{5,25}$/.test(String(igsid))) return null;
  const r = await graphGet(`https://graph.instagram.com/${cfg.meta.graphVersion}/${igsid}?fields=name,username`, token, deps);
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
  const r = await graphPost(`https://graph.instagram.com/${config.meta.graphVersion}/me/messages`, cfg.meta.instagram.accessToken, { recipient: { id: to }, message: { text } }, deps);
  if (r.ok) return { ok: true, externalId: r.body?.message_id ?? null };
  return { ok: false, reason: r.status ? `Instagram refused the message${r.body?.error?.message ? `: ${r.body.error.message}` : ` (HTTP ${r.status})`}.` : `Could not reach Instagram (${r.error}).` };
}
