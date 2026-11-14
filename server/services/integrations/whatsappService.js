// WhatsApp Cloud API. Reports 'connected' ONLY after a successful credential check against the Graph API.
// There is no OAuth/Embedded Signup flow here: credentials are supplied via environment variables.
import { config } from '../../config/env.js';
import { graphGet, graphPost, graphBase } from './graph.js';

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
    const said = r.body?.error?.message ? ` Meta says: ${String(r.body.error.message).slice(0, 160)}` : '';
    const why = r.status ? `Meta rejected the credentials (HTTP ${r.status}).${said}${r.status === 401 ? ' Generate a new WHATSAPP_ACCESS_TOKEN.' : ''}` : `Could not reach Meta (${r.error}).`;
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

// What the customer wrote, whatever the kind of message: the text, the caption of a picture or file, or the label of a button / list option they tapped.
const textOf = (m) => (m.type === 'text' ? m.text?.body ?? null : ['image', 'document', 'video'].includes(m.type) ? m[m.type]?.caption ?? null
  : m.type === 'button' ? m.button?.text ?? null : m.type === 'interactive' ? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null : null);

// Delivery receipts for messages WE sent: entry[].changes[].value.statuses[] = { id, status: sent|delivered|read|failed, timestamp, errors? }.
export function parseStatuses(body) {
  const out = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) for (const change of entry.changes ?? []) {
    if (change.field !== 'messages') continue;
    for (const st of change.value?.statuses ?? []) {
      if (!st?.id || !['sent', 'delivered', 'read', 'failed'].includes(st.status)) continue;
      out.push({ channel: CHANNEL, externalId: String(st.id), status: st.status, at: st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date(), error: st.errors?.[0]?.title ?? st.errors?.[0]?.message ?? null });
    }
  }
  return out;
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
          messageType: m.type ?? 'unknown', text: textOf(m),
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
// `report.reason` says why nothing came back (never a token): the connection is not set up, Meta refused the token, the media expired, or the network failed.
export async function downloadMedia(mediaId, { fetchImpl = fetch, timeoutMs = 10000, maxBytes = 5 * 1024 * 1024, report = {} } = {}, cfg = config) {
  const token = cfg.meta.whatsapp.accessToken;
  if (!token) { report.reason = 'WhatsApp is not connected (no access token).'; return null; }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(mediaId)) { report.reason = 'The picture id is not valid.'; return null; }
  const meta = await graphGet(`${graphBase()}/${encodeURIComponent(mediaId)}`, token, { fetchImpl, timeoutMs });
  if (!meta.ok) { report.reason = meta.status === 401 || meta.status === 190 || meta.body?.error?.code === 190 ? 'Meta rejected the WhatsApp access token (it has expired or was revoked). Reconnect WhatsApp, then retry.' : meta.status === 0 ? 'Could not reach Meta.' : `Meta could not find the picture (HTTP ${meta.status}).`; return null; }
  const url = meta.body?.url;
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]*(facebook|fbcdn|fbsbx|whatsapp)\.(com|net)\//i.test(url)) { report.reason = 'Meta returned no usable download link.'; return null; } // only ever fetch from Meta's own hosts
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    if (!res.ok) { report.reason = `The download was refused (HTTP ${res.status}).`; return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) { report.reason = buf.length === 0 ? 'The downloaded picture was empty.' : 'The picture is too large.'; return null; }
    return buf;
  } catch { report.reason = 'The download failed (network).'; return null; } finally { clearTimeout(timer); }
}

// A WhatsApp number in international (E.164) form: "+" and 8 to 15 digits, the first not 0. Spaces, dashes and brackets are tolerated on the way in.
export function toE164(raw) {
  const digits = String(raw ?? '').replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

// What a refusal from Meta means, in words for the owner. `kind` lets the caller react (a dead token needs reconnecting; a closed window needs a template).
export function explainSend(r) {
  const e = r.body?.error ?? {}; const code = Number(e.code); const said = e.error_data?.details || e.message || '';
  if (r.status === 0) return { kind: 'network', code: 'NETWORK', reason: `Could not reach WhatsApp (${r.error}). Nothing was sent; try again in a moment.` };
  if (r.status === 401 || code === 190) return { kind: 'token', code: 190, reason: 'WhatsApp rejected the access token (invalid or expired). Nothing was sent. Create a new System User token, set WHATSAPP_ACCESS_TOKEN and restart the server.' };
  if (code === 131030) return { kind: 'recipient_not_allowed', code, reason: 'This number is not on the allowed recipient list for your WhatsApp test number (Meta error 131030). In Meta → WhatsApp → API Setup, add the customer\'s number under "To" and confirm the code WhatsApp sends them. Nothing was sent.' };
  if (code === 131047 || code === 131051 && /re-?engage|24/i.test(said)) return { kind: 'window_closed', code, reason: 'The customer last wrote more than 24 hours ago, so WhatsApp only accepts an approved template message (Meta error 131047). Nothing was sent.' };
  if ([4, 80007, 130429, 131048, 131056].includes(code) || r.status === 429) return { kind: 'rate_limit', code, reason: `WhatsApp is limiting how fast messages can be sent (Meta error ${code || 429}). Wait a little and try again. Nothing was sent.` };
  if (code === 131026) return { kind: 'undeliverable', code, reason: 'WhatsApp could not deliver to this number (Meta error 131026): it may not be on WhatsApp, or the customer has not accepted WhatsApp\'s latest terms. Nothing was sent.' };
  if (code === 133010 || (code === 100 && /phone number/i.test(said))) return { kind: 'sender', code, reason: 'WhatsApp does not recognise the sending number. Check WHATSAPP_PHONE_NUMBER_ID. Nothing was sent.' };
  if (r.status === 400 || [100, 131008, 131009, 132000, 132001, 132005, 132012].includes(code)) return { kind: 'invalid', code: code || 400, reason: `WhatsApp rejected the request as invalid${said ? `: ${said}` : ''}. Check the customer's number and the message. Nothing was sent.` };
  return { kind: 'other', code: code || r.status, reason: `WhatsApp refused the message${said ? `: ${said}` : ` (HTTP ${r.status})`}. Nothing was sent.` };
}

async function post(payload, deps, cfg) {
  const missing = missingConfig(cfg);
  if (missing.length) return { ok: false, kind: 'config', code: 'NOT_CONFIGURED', reason: `Not configured. Missing environment variables: ${missing.join(', ')}.` };
  const to = toE164(payload.to);
  if (!to) return { ok: false, kind: 'invalid_recipient', code: 'INVALID_RECIPIENT', reason: 'This customer\'s WhatsApp number is not a valid international number, so nothing was sent.' };
  const r = await graphPost(`${graphBase()}/${encodeURIComponent(cfg.meta.whatsapp.phoneNumberId)}/messages`, cfg.meta.whatsapp.accessToken, { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload, to: to.slice(1) }, deps);
  if (r.ok) { const id = r.body?.messages?.[0]?.id ?? null; return id ? { ok: true, externalId: id, to } : { ok: false, kind: 'other', code: 'NO_MESSAGE_ID', reason: 'WhatsApp answered without a message id, so delivery cannot be tracked. Nothing is recorded as sent.' }; }
  return { ok: false, ...explainSend(r) };
}

// Sends a plain text message (WhatsApp Cloud API). Meta only accepts free-form text within 24 hours of the customer's last message.
export const sendText = (to, text, deps = {}, cfg = config) => post({ to, type: 'text', text: { body: text, preview_url: false } }, deps, cfg);

// Sends an approved message template: the only message WhatsApp allows outside the 24-hour window (and the one that opens it again once the customer replies).
export const sendTemplate = (to, { name, language = 'en_US' }, deps = {}, cfg = config) => post({ to, type: 'template', template: { name, language: { code: language } } }, deps, cfg);
