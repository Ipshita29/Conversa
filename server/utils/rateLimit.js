import { ApiError } from './errors.js';

// Small in-memory fixed-window limiter (per IP). Protects paid/third-party calls such as the LLM.
export function rateLimit({ max, windowMs = 60000 }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || now > entry.reset) hits.set(key, { count: 1, reset: now + windowMs });
    else if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return next(new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please try again shortly.'));
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    next();
  };
}
