import { isDbReady } from '../config/db.js';
import { ApiError } from '../utils/errors.js';

export const requireDb = (req, res, next) =>
  isDbReady() ? next() : next(new ApiError(503, 'DB_UNAVAILABLE', 'The database is not available right now. Please try again shortly.'));
