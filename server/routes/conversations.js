import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import { list } from '../controllers/conversationController.js';

const r = Router();
r.get('/', requireDb, list);
export default r;
