import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { rateLimit } from '../utils/rateLimit.js';
import { config } from '../config/env.js';
import { extract } from '../controllers/aiController.js';

const r = Router();
// DB is needed only for business settings (timezone, prep rules). Rate-limited to protect the LLM quota.
r.post('/extract-order', rateLimit({ max: config.aiRateLimitPerMinute }), requireDb, extract);
export default r;
