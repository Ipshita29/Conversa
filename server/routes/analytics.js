import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { getMonthly } from '../controllers/analyticsController.js';

const r = Router();
r.get('/monthly', requireDb, getMonthly);
export default r;
