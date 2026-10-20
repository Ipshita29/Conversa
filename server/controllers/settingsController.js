import { asyncHandler } from '../utils/errors.js';
import { getSettings, updateSettings } from '../services/settingsService.js';

export const get = asyncHandler(async (req, res) => res.json(await getSettings()));
export const patch = asyncHandler(async (req, res) => res.json(await updateSettings(req.body)));
