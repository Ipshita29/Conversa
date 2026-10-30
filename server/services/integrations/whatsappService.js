// WhatsApp Cloud API. Reports 'connected' ONLY after a successful credential check against the Graph API.
// There is no OAuth/Embedded Signup flow here: credentials are supplied via environment variables.
import { config } from '../../config/env.js';
import { graphGet, graphBase } from './graph.js';

export const CHANNEL = 'whatsapp';

export function missingConfig(cfg = config) {
  const m = [];
  if (!cfg.meta.whatsapp.accessToken) m.push('WHATSAPP_ACCESS_TOKEN');
  if (!cfg.meta.whatsapp.phoneNumberId) m.push('WHATSAPP_PHONE_NUMBER_ID');
  return m;
}
export const webhookMissing = (cfg = config) => [
  ...(cfg.meta.whatsapp.verifyToken ? [] : ['WHATSAPP_VERIFY_TOKEN']),
  ...(cfg.meta.appSecret ? [] : ['META_APP_SECRET']),
];

export async function checkStatus(deps = {}, cfg = config) {
  const missing = missingConfig(cfg);
  const base = { channel: CHANNEL, accountLabel: null, lastSyncAt: null, webhookConfigured: webhookMissing(cfg).length === 0 };
  if (missing.length) return { ...base, status: 'unavailable', statusReason: `Not configured. Missing environment variables: ${missing.join(', ')}.` };

  const r = await graphGet(`${graphBase()}/${encodeURIComponent(cfg.meta.whatsapp.phoneNumberId)}?fields=display_phone_number,verified_name`, cfg.meta.whatsapp.accessToken, deps);
  if (!r.ok) {
    const why = r.status ? `Meta rejected the credentials (HTTP ${r.status}).` : `Could not reach Meta (${r.error}).`;
    return { ...base, status: 'unavailable', statusReason: why };
  }
  const label = r.body?.verified_name || r.body?.display_phone_number || null;
  const wh = webhookMissing(cfg);
  return { ...base, status: 'connected', statusReason: wh.length ? `Credentials verified. Incoming messages are disabled until ${wh.join(', ')} is set.` : 'Credentials verified with the WhatsApp Cloud API.', accountLabel: label };
}

export function verifyChallenge(query, cfg = config) {
  const expected = cfg.meta.whatsapp.verifyToken;
  if (!expected) return { ok: false, status: 503 };
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected && query['hub.challenge'] !== undefined) return { ok: true, challenge: String(query['hub.challenge']) };
  return { ok: false, status: 403 };
}

// Payload: entry[].changes[].value.{contacts[], messages[]} (WhatsApp Cloud API webhooks).
export function parseWebhook(body) {
  const out = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== 'messages' || !Array.isArray(v?.messages)) continue;
      const names = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
      for (const m of v.messages) {
        if (!m?.id || !m?.from) continue;
        out.push({
          channel: CHANNEL, externalId: String(m.id), contactId: String(m.from), contactName: names[m.from] ?? null,
          messageType: m.type ?? 'unknown', text: m.type === 'text' ? m.text?.body ?? null : m.type === 'image' ? m.image?.caption ?? null : null,
          ...(m.type === 'image' && m.image?.id ? { mediaId: String(m.image.id) } : {}),
          receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
        });
      }
    }
  }
  return out;
}

// Downloads an image a customer sent (WhatsApp Cloud API: media id -> short-lived URL -> bytes). Needs WHATSAPP_ACCESS_TOKEN. Returns
// a Buffer, or null on any problem: the message is still kept, just without its picture. The token is only ever sent to Meta.
export async function downloadMedia(mediaId, { fetchImpl = fetch, timeoutMs = 10000, maxBytes = 5 * 1024 * 1024 } = {}, cfg = config) {
  const token = cfg.meta.whatsapp.accessToken;
  if (!token || !/^[A-Za-z0-9_-]{4,64}$/.test(mediaId)) return null;
  const meta = await graphGet(`${graphBase()}/${encodeURIComponent(mediaId)}`, token, { fetchImpl, timeoutMs });
  const url = meta.ok ? meta.body?.url : null;
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]*(facebook|fbcdn|fbsbx|whatsapp)\.(com|net)\//i.test(url)) return null; // only ever fetch from Meta's own hosts
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= maxBytes ? buf : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
