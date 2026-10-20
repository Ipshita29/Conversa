import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import * as c from '../controllers/settingsController.js';

const r = Router();
r.use(requireDb);
r.get('/', c.get);
r.patch('/', c.patch);
export default r;
