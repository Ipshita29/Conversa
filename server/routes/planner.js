import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { getPlanner, simulatePlanner, whatIf, whatIfMove } from '../controllers/plannerController.js';

const r = Router();
r.use(requireDb);
r.get('/', getPlanner);
r.post('/simulate', simulatePlanner);
r.get('/whatif', whatIf);
r.post('/whatif/move', whatIfMove);
export default r;
