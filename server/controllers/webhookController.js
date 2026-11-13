import { asyncHandler, ApiError } from '../utils/errors.js';
import { config } from '../config/env.js';
import { channels } from '../services/integrations/index.js';
import { verifyMetaSignature } from '../utils/signature.js';
import { ingest, applyStatuses } from '../services/messageService.js';
import { log } from '../utils/log.js';
import { scheduleAutoDraft } from '../services/autoDraftService.js';

const svcFor = (req) => channels[req.params.channel];

// GET: Meta's subscription handshake (hub.mode / hub.verify_token / hub.challenge).
export const verify = (req, res, next) => {
  const svc = svcFor(req);
  if (!svc) return next(new ApiError(404, 'NOT_FOUND', 'Unknown channel.'));
  const r = svc.verifyChallenge(req.query);
  if (r.ok) return res.status(200).type('text/plain').send(r.challenge);
  return next(new ApiError(r.status, r.status === 503 ? 'INTEGRATION_UNAVAILABLE' : 'FORBIDDEN', r.status === 503 ? 'Webhook verify token is not configured.' : 'Webhook verification failed.'));
};

// POST: signature is verified over the RAW body BEFORE anything is parsed or stored.
export const receive = asyncHandler(async (req, res) => {
  const svc = svcFor(req);
  if (!svc) throw new ApiError(404, 'NOT_FOUND', 'Unknown channel.');
  if (!config.meta.appSecret) throw new ApiError(503, 'INTEGRATION_UNAVAILABLE', 'META_APP_SECRET is not configured; webhooks are disabled.');
  if (!verifyMetaSignature(req.rawBody, req.get('X-Hub-Signature-256'), config.meta.appSecret)) throw new ApiError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature.');
  const parsed = svc.parseWebhook(req.body);
  const receipts = svc.parseStatuses ? svc.parseStatuses(req.body) : [];
  if (parsed.length === 0 && receipts.length === 0) { // an event we do not handle: say what KIND it was (field names only, never content) so a new payload shape is easy to spot
    const kinds = (req.body?.entry ?? []).flatMap((e) => [...Object.keys(e).filter((k) => k !== 'id' && k !== 'time'), ...(e.changes ?? []).map((c) => `changes:${c?.field}`)]);
    log.info('webhook', `${req.params.channel}: ignored an event with no message in it`, { object: req.body?.object, kinds: [...new Set(kinds)].slice(0, 6) });
  }
  const result = await ingest(parsed); // DB errors -> 5xx so Meta retries; duplicates are skipped
  const statuses = await applyStatuses(receipts); // delivery / read receipts for messages we sent
  if (result.stored || statuses) log.info('webhook', `${req.params.channel}: ${result.stored} stored, ${result.duplicates} duplicate, ${statuses} status updates`);
  // Acknowledge Meta at once; reading the conversation into an order draft (an AI call) happens afterwards, never inside the webhook request.
  res.status(200).json({ received: true, stored: result.stored, duplicates: result.duplicates, statuses });
  for (const id of result.toRead) scheduleAutoDraft(id);
});
