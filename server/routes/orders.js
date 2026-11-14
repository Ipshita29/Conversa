import { Router, raw } from 'express';
import { requireDb } from '../middleware/requireDb.js';
import * as c from '../controllers/orderController.js';

const r = Router();
r.use(requireDb);
r.get('/', c.list);
r.post('/', c.create);
r.get('/:id', c.get);
r.patch('/:id', c.update);
r.delete('/:id', c.remove);
r.get('/:id/conversation', c.conversation);
r.post('/:id/payment-evidence', c.addPaymentEvidence);
r.post('/:id/reference-images', raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }), c.addReferenceImage);
r.get('/:id/reference-images/:imageId', c.referenceImageFile);
r.delete('/:id/reference-images/:imageId', c.removeReferenceImage);
export default r;
