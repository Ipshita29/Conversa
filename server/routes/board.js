import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { getBoard } from '../controllers/analyticsController.js';

const r = Router();
r.get('/', requireDb, getBoard);
export default r;
