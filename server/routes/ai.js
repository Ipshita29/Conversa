import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { rateLimit } from '../utils/rateLimit.js';
import { config } from '../config/env.js';
import { extract } from '../controllers/aiController.js';
import { suggestFromBody } from '../controllers/conversationController.js';

const r = Router();
// DB is needed only for business settings (timezone, prep rules). Rate-limited to protect the LLM quota.
r.post('/extract-order', rateLimit({ max: config.aiRateLimitPerMinute }), requireDb, extract);
// Reply suggestions for a context the browser built (demo chats live in the browser). No database needed; sends nothing.
r.post('/suggest-replies', rateLimit({ max: config.aiRateLimitPerMinute }), suggestFromBody);
export default r;
