import { asyncHandler, ApiError, validationError } from '../utils/errors.js';
import { isPlainObject } from '../utils/validation.js';
import * as svc from '../services/paymentService.js';
import { checkImage } from '../services/proofStore.js';

const body = (req) => (Buffer.isBuffer(req.body) && req.body.length ? req.body : null);

export const ledger = asyncHandler(async (req, res) => res.json(await svc.getLedger()));
export const get = asyncHandler(async (req, res) => res.json(await svc.getPayment(req.params.id)));
export const create = asyncHandler(async (req, res) => {
  const payment = await svc.createPayment(req.body);
  res.status(201).location(`/api/payments/${payment.id}`).json(payment);
});
export const confirm = asyncHandler(async (req, res) => res.json(await svc.confirmPayment(req.params.id, req.body)));
export const reject = asyncHandler(async (req, res) => res.json(await svc.rejectPayment(req.params.id, req.body)));
export const refund = asyncHandler(async (req, res) => res.status(201).json(await svc.refundPayment(req.params.id, req.body)));

export const uploadProof = asyncHandler(async (req, res) => {
  const buf = body(req);
  if (!buf) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Send the image as the request body (Content-Type image/png, image/jpeg or image/webp).');
  checkImage(buf);
  res.status(201).json(await svc.attachProof(req.params.id, buf, req.get('X-File-Name')));
});

// Served only through this route: fixed type, no sniffing, never cached by shared caches, never rendered as a page.
export const proof = asyncHandler(async (req, res) => {
  const { data, contentType } = await svc.getProofFile(req.params.id);
  res.set({ 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:" });
  res.send(data);
});

export const extractText = asyncHandler(async (req, res) => {
  if (!isPlainObject(req.body)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const r = await svc.extractFromText(req.body);
  res.status(r.payment ? 201 : 200).json(r);
});

export const extractImage = asyncHandler(async (req, res) => {
  const buf = body(req);
  if (!buf) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Send the screenshot as the request body (Content-Type image/png, image/jpeg or image/webp).');
  const r = await svc.extractFromImage({ buffer: buf, orderId: req.query.orderId, conversationId: req.query.conversationId, fileName: req.get('X-File-Name') });
  res.status(201).json(r);
});

// Reading only (nothing is saved or stored); used when the orders live in the browser's demo data rather than in this database.
export const readImage = asyncHandler(async (req, res) => {
  const buf = body(req);
  if (!buf) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'Send the screenshot as the request body (Content-Type image/png, image/jpeg or image/webp).');
  res.json(await svc.readImageOnly(buf));
});
