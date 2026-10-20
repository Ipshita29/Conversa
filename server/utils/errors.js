// Error format from docs/api-contract.md: { error: { code, message, details? } }
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const validationError = (details, message = 'Request validation failed.') => new ApiError(422, 'VALIDATION_ERROR', message, details);
export const badQuery = (details) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid query.', details);
export const notFound = (what, id) => new ApiError(404, 'NOT_FOUND', `${what} '${id}' not found.`);

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
