import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { getDashboard } from '../controllers/dashboardController.js';

const r = Router();
r.get('/', requireDb, getDashboard);
export default r;
