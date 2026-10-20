import { Router } from 'express';
import { list, connect } from '../controllers/integrationController.js';

const r = Router();
r.get('/', list);
r.post('/:channel/connect', connect);
export default r;
