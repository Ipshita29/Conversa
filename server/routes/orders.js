import { Router } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import * as c from '../controllers/orderController.js';

const r = Router();
r.use(requireDb);
r.get('/', c.list);
r.post('/', c.create);
r.get('/:id', c.get);
r.patch('/:id', c.update);
r.post('/:id/payment-evidence', c.addPaymentEvidence);
export default r;
