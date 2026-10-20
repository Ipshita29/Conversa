import { ApiError } from '../utils/errors.js';

export const notFoundHandler = (req, res, next) => next(new ApiError(404, 'NOT_FOUND', `No route ${req.method} ${req.path}.`));

// Central error handler. Never leaks stack traces or internal messages.
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  let e = err;
  if (err?.type === 'entity.parse.failed') e = new ApiError(400, 'VALIDATION_ERROR', 'Malformed JSON body.');
  else if (err?.type === 'entity.too.large') e = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  else if (err?.name === 'ValidationError' && err.errors) {
    e = new ApiError(422, 'VALIDATION_ERROR', 'Request validation failed.', Object.values(err.errors).map((x) => ({ field: x.path, message: x.message })));
  } else if (err?.name === 'CastError') e = new ApiError(404, 'NOT_FOUND', 'Resource not found.');

  if (!(e instanceof ApiError)) {
    console.error(`Unhandled error on ${req.method} ${req.path}: ${err?.name ?? 'Error'}`); // no body/headers logged
    e = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong on the server.');
  }
  if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details?.length ? { details: e.details } : {}) } });
}
