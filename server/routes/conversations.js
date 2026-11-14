import { Router, raw } from 'express';
import { rateLimit } from '../utils/rateLimit.js';
import { config } from '../config/env.js';
import { requireDb } from '../middleware/requireDb.js';
import { list, patch, draftOrder, createOrder, suggestions, orderSummary, sendMessage, uploadAttachment, attachment, extractPayment, retryPictures, sendTemplate } from '../controllers/conversationController.js';

const r = Router();
r.use(requireDb);
r.get('/', list);
r.patch('/:id', patch);
const image = raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' });
r.post('/:id/attachments', image, uploadAttachment);
r.get('/:id/messages/:mid/attachment', attachment);
r.post('/:id/retry-pictures', retryPictures); // download again the pictures that could not be fetched (e.g. after reconnecting WhatsApp)
r.post('/:id/messages/:mid/retry-picture', retryPictures);
r.post('/:id/messages/:mid/extract-payment', rateLimit({ max: config.aiRateLimitPerMinute }), extractPayment);
r.post('/:id/suggestions', rateLimit({ max: config.aiRateLimitPerMinute }), suggestions);
r.get('/:id/order-summary', orderSummary);
r.post('/:id/messages', sendMessage);
r.post('/:id/template-message', sendTemplate); // an approved WhatsApp template: the only message allowed after the 24-hour window
r.post('/:id/draft-order', rateLimit({ max: config.aiRateLimitPerMinute }), draftOrder);
r.post('/:id/orders', createOrder);
export default r;
