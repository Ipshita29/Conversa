import { asyncHandler, ApiError } from '../utils/errors.js';
import { config } from '../config/env.js';
import { channels } from '../services/integrations/index.js';
import { verifyMetaSignature } from '../utils/signature.js';
import { ingest } from '../services/messageService.js';

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
  const result = await ingest(svc.parseWebhook(req.body)); // DB errors -> 5xx so Meta retries; duplicates are skipped
  res.status(200).json({ received: true, ...result });
});
