import { asyncHandler, ApiError } from '../utils/errors.js';
import { channels, listStatuses, clearStatusCache } from '../services/integrations/index.js';

export const list = asyncHandler(async (req, res) => res.json({ items: await listStatuses() }));

// Credentials come from server environment variables (no OAuth flow). "Connect" re-verifies them with Meta.
export const connect = asyncHandler(async (req, res) => {
  const { channel } = req.params;
  const svc = channels[channel];
  if (!svc) throw new ApiError(404, 'NOT_FOUND', `Unknown channel '${channel}'.`);
  clearStatusCache();
  const status = await svc.checkStatus();
  if (status.status !== 'connected') throw new ApiError(503, 'INTEGRATION_UNAVAILABLE', status.statusReason);
  res.json({ channel, status: 'connected', accountLabel: status.accountLabel, authorizationUrl: null, statusReason: status.statusReason });
});
