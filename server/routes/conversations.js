import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { list, patch } from '../controllers/conversationController.js';

const r = Router();
r.use(requireDb);
r.get('/', list);
r.patch('/:id', patch);
export default r;
