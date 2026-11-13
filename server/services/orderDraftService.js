// From a real conversation to a real order: the customer's messages about ONE order are read together into an editable draft, and the owner's
// confirmation creates exactly one order, linked to the conversation. Nothing is created by reading; prices and deadlines are never invented.
import mongoose from 'mongoose';
import Conversation from '../models/Conversation.js';
import Order from '../models/Order.js';
import { conversationWithMessages } from './messageService.js';
import { extractOrder } from './extractionService.js';
import { getSettings } from './settingsService.js';
import { riskMap, withRisk } from './orderService.js';
import { validateOrderInput } from '../utils/validation.js';
import { ApiError, notFound, validationError } from '../utils/errors.js';

const ID = /^[a-f\d]{24}$/i;
const MAX_CHARS = 3800;
const BUY = /\b(i (want|need|would like|'?d like|wanna)|we (want|need)|please (make|prepare|book|arrange)|(can|could) (you|i) (make|get|have|order|book)|(place|book|confirm) (the |an? |my )?order|let'?s (go|confirm)|go ahead|confirm(ed)? (it|the order)|i('ll| will) take|deliver(y)? (it )?(by|on|at))\b/i;
const ASK = /(\?|\b(how much|price|cost|rate|do you (make|have|take|do)|are you|available|availability|what.?s the)\b)/i;

// The intent, decided in code as well as by the model: "order" needs both buying language from the customer and an item; a question alone is an enquiry.
export function classifyIntent(customerTexts, item, aiIntent = 'unclear') {
  const said = customerTexts.join('\n');
  const buying = BUY.test(said);
  if (buying && item) return aiIntent === 'enquiry' && !/\b(confirm|go ahead|let'?s)\b/i.test(said) ? 'unclear' : 'order';
  if (ASK.test(said) && !buying) return 'enquiry';
  return aiIntent === 'enquiry' ? 'enquiry' : 'unclear';
}

export async function draftFromConversation(convId, deps = {}, { ignoreLinked = false } = {}) {
  const { conv, messages } = await conversationWithMessages(convId);
  if (conv.orderId && !ignoreLinked) {
    const existing = await Order.findById(conv.orderId);
    if (existing) return { existingOrderId: String(existing._id), draft: null, intent: 'order', readyToConfirm: false, missingFields: [], uncertainties: [], note: 'This conversation already has an order. Later messages are kept as updated instructions on it; no second order is drafted.' };
  }
  const lines = messages.filter((m) => m.text).map((m) => ({ who: m.from === 'customer' ? 'Customer' : 'Business', text: m.text, id: m.id }));
  if (!lines.some((l) => l.who === 'Customer')) throw new ApiError(422, 'NO_MESSAGES', 'This conversation has no customer text to read yet.');
  let message = '';
  const used = [];
  for (const l of [...lines].reverse()) { const row = `${l.who}: ${l.text}\n`; if (message.length + row.length > MAX_CHARS) break; message = row + message; used.unshift(l.id); }
  const settings = await getSettings();
  const r = await extractOrder({ message: message.trim(), source: conv.channel, customerName: conv.customerName }, settings, deps);
  const intent = classifyIntent(lines.filter((l) => l.who === 'Customer').map((l) => l.text), r.draft.item, r.aiIntent);
  const missing = r.missingFields.filter((f) => f !== 'prepTimeMinutes' || r.draft.prepTimeMinutes === null);
  return { existingOrderId: null, draft: r.draft, intent, missingFields: missing, uncertainties: r.uncertainties, estimates: r.estimates,
    readyToConfirm: intent === 'order' && missing.length === 0, sourceMessageIds: used, conversationId: String(conv._id) };
}

// One order per conversation, created and linked in one guarded step: the link is claimed first (only while the conversation has none), so a double
// click, a refresh or a retried request can never produce a second order. A request that loses the race gets the existing order back (409).
export async function createOrderForConversation(convId, body) {
  if (!ID.test(String(convId))) throw notFound('Conversation', convId);
  const conv = await Conversation.findById(convId);
  if (!conv) throw notFound('Conversation', convId);
  const { value, details } = validateOrderInput({ ...body, source: conv.channel });
  if (details.length) throw validationError(details);
  const id = new mongoose.Types.ObjectId();
  const claimed = await Conversation.updateOne({ _id: conv._id, orderId: null }, { $set: { orderId: id } });
  if (claimed.modifiedCount !== 1) {
    const current = await Conversation.findById(convId).lean();
    const e = new ApiError(409, 'ORDER_EXISTS', 'This conversation already has an order. Open it instead of creating another.', [{ field: 'orderId', message: String(current?.orderId ?? '') }]);
    e.existingOrderId = current?.orderId ? String(current.orderId) : null;
    throw e;
  }
  try {
    const order = await Order.create({ ...value, _id: id, ...(!conv.isDemo ? { customerContact: conv.contactId } : {}) });
    return withRisk(order, await riskMap(await getSettings()));
  } catch (err) {
    await Conversation.updateOne({ _id: conv._id, orderId: id }, { $set: { orderId: null } }); // nothing was created: free the conversation again
    throw err;
  }
}
