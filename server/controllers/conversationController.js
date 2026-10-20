import { asyncHandler } from '../utils/errors.js';
import { listConversations } from '../services/messageService.js';

// Proposed addition (not yet in docs/api-contract.md): conversations stored from webhooks.
export const list = asyncHandler(async (req, res) => res.json({ items: await listConversations() }));
