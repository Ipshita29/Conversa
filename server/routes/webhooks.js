import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { rateLimit } from '../utils/rateLimit.js';
import { verify, receive } from '../controllers/webhookController.js';

const r = Router();
r.get('/:channel', verify);
// Generous (Meta can deliver bursts) but bounded, so a flood of forged posts cannot hammer the database; a forged one is rejected by its signature anyway.
r.post('/:channel', rateLimit({ max: 600 }), requireDb, receive);
export default r;
