import { Router, raw } from 'express';
import { rateLimit } from '../utils/rateLimit.js';
import { config } from '../config/env.js';
import { requireDb } from '../middleware/requireDb.js';
import { list, patch, uploadAttachment, attachment, extractPayment } from '../controllers/conversationController.js';

const r = Router();
r.use(requireDb);
r.get('/', list);
r.patch('/:id', patch);
const image = raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' });
r.post('/:id/attachments', image, uploadAttachment);
r.get('/:id/messages/:mid/attachment', attachment);
r.post('/:id/messages/:mid/extract-payment', rateLimit({ max: config.aiRateLimitPerMinute }), extractPayment);
export default r;
