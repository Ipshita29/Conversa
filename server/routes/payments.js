import { Router, raw } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { rateLimit } from '../utils/rateLimit.js';
import { config } from '../config/env.js';
import * as c from '../controllers/paymentController.js';

const image = raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' });
const r = Router();
// Reading a screenshot touches no database, so it does not need one. It is rate-limited like every other AI call.
r.post('/read-image', rateLimit({ max: config.aiRateLimitPerMinute }), image, c.readImage);
r.use(requireDb);
r.get('/', c.ledger);
r.post('/', c.create);
r.post('/extract', c.extractText);
r.post('/extract-image', rateLimit({ max: config.aiRateLimitPerMinute }), image, c.extractImage);
r.get('/:id', c.get);
r.post('/:id/confirm', c.confirm);
r.post('/:id/reject', c.reject);
r.post('/:id/refund', c.refund);
r.post('/:id/proof', image, c.uploadProof);
r.get('/:id/proof', c.proof);
export default r;
