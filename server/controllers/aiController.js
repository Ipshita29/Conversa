import { asyncHandler, validationError } from '../utils/errors.js';
import { getSettings } from '../services/settingsService.js';
import { extractOrder, validateExtractRequest } from '../services/extractionService.js';

// Returns a DRAFT only. Nothing is saved: the client submits POST /api/orders after the seller confirms.
export const extract = asyncHandler(async (req, res) => {
  const { value, details } = validateExtractRequest(req.body);
  if (details.length) throw validationError(details);
  const settings = await getSettings();
  res.json(await extractOrder(value, settings));
});
