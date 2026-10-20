// Instagram messaging (Instagram API with Instagram Login). Reports 'connected' ONLY after a successful credential check.
// Requires an Instagram professional account and Meta app permissions/review; none of that is automated here.
import { config } from '../../config/env.js';
import { graphGet } from './graph.js';

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

// Payload: entry[].messaging[] = { sender:{id}, recipient:{id}, timestamp, message:{mid,text,is_echo?} }.
export function parseWebhook(body) {
  const out = [];
  if (!body || body.object !== 'instagram' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      if (!m?.mid || !ev.sender?.id || m.is_echo) continue; // ignore our own outgoing messages
      out.push({
        channel: CHANNEL, externalId: String(m.mid), contactId: String(ev.sender.id), contactName: null,
        messageType: m.text !== undefined ? 'text' : 'unsupported', text: m.text ?? null,
        receivedAt: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date(),
      });
    }
  }
  return out;
}
