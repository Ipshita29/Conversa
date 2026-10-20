import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { verify, receive } from '../controllers/webhookController.js';

const r = Router();
r.get('/:channel', verify);
r.post('/:channel', requireDb, receive);
export default r;
