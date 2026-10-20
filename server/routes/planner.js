import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { getPlanner, simulatePlanner } from '../controllers/plannerController.js';

const r = Router();
r.use(requireDb);
r.get('/', getPlanner);
r.post('/simulate', simulatePlanner);
export default r;
