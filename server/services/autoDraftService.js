// Real conversations become order drafts by themselves. When a customer's message arrives (and a short pause passes, so several quick messages are read
// together), the whole conversation is read once and:
//   - an ENQUIRY or an unclear message creates nothing;
//   - the first message that clearly orders something creates ONE draft order (status "draft"), linked to the conversation;
//   - later messages update that same draft (a correction replaces the old value; nothing the customer did not say is ever filled in);
//   - once the owner has edited the draft only blanks are filled, and once it is confirmed nothing changes automatically.
// A draft is never scheduled, counted or reported until the owner confirms it. Failures (no AI key, AI down) are logged and change nothing.
import Conversation from '../models/Conversation.js';
import Order from '../models/Order.js';
import { config } from '../config/env.js';
import { log } from '../utils/log.js';
import { draftFromConversation, createOrderForConversation } from './orderDraftService.js';

const FIELDS = ['item', 'quantity', 'customisation', 'notes', 'price', 'deadline', 'prepTimeMinutes'];
const blank = (v) => v === null || v === undefined || v === '';
const same = (a, b) => (a instanceof Date || b instanceof Date ? new Date(a ?? 0).getTime() === new Date(b ?? 0).getTime() : a === b);

export async function autoDraftForConversation(convId, deps = {}) {
  const conv = await Conversation.findById(convId).lean();
  if (!conv || conv.isDemo) return { action: 'skipped', reason: 'demo_or_missing' };
  let order = conv.orderId ? await Order.findById(conv.orderId) : null;
  if (order && order.status !== 'draft') return { action: 'skipped', reason: 'order_confirmed', orderId: String(order._id) }; // later messages stay as updated instructions
  const r = await draftFromConversation(convId, deps, { ignoreLinked: true });
  if (r.intent !== 'order' || !r.draft?.item) return { action: 'skipped', reason: 'not_an_order', intent: r.intent };
  const assumed = [...(r.estimates?.prepTimeMinutes ? ['prepTimeMinutes'] : []), ...r.uncertainties.filter((u) => u.field === 'deadline' && /assumed/i.test(u.message)).map(() => 'deadlineTime')];
  const meta = { auto: true, missingFields: r.missingFields, uncertainties: r.uncertainties, assumed, messageIds: r.sourceMessageIds ?? [], extractedAt: new Date() };
  const fresh = Object.fromEntries(FIELDS.filter((f) => !blank(r.draft[f])).map((f) => [f, f === 'deadline' ? new Date(r.draft[f]) : r.draft[f]]));

  if (!order) {
    try {
      const body = { customerName: r.draft.customerName || conv.customerName || 'Unknown customer', status: 'draft', ...Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])) };
      const created = await createOrderForConversation(convId, body);
      const now = new Date();
      await Order.updateOne({ _id: created.id }, { $set: { draft: { ...meta, autoUpdatedAt: now, ownerEdited: false }, updatedAt: now } }, { timestamps: false });
      log.info('draft', `Created an order draft from a ${conv.channel} conversation.`);
      return { action: 'created', orderId: created.id };
    } catch (e) {
      if (e.code !== 'ORDER_EXISTS') throw e; // another run created it a moment ago: update that one instead
      order = await Order.findById(e.existingOrderId);
      if (!order || order.status !== 'draft') return { action: 'skipped', reason: 'order_confirmed' };
    }
  }

  const ownerTouched = Boolean(order.draft?.autoUpdatedAt) && order.updatedAt.getTime() > new Date(order.draft.autoUpdatedAt).getTime() + 1;
  const set = {};
  for (const [f, v] of Object.entries(fresh)) {
    if (ownerTouched ? blank(order[f]) : !same(order[f], v)) set[f] = v; // the owner's own edits are never overwritten; a customer's correction is
  }
  const now = new Date();
  const next = { ...meta, autoUpdatedAt: ownerTouched ? order.draft?.autoUpdatedAt ?? now : now, ownerEdited: ownerTouched };
  if (Object.keys(set).length === 0 && JSON.stringify(order.draft?.missingFields ?? []) === JSON.stringify(meta.missingFields)) return { action: 'unchanged', orderId: String(order._id) };
  await Order.updateOne({ _id: order._id }, { $set: { ...set, draft: next, ...(ownerTouched ? {} : { updatedAt: now }) } }, { timestamps: false });
  return { action: 'updated', orderId: String(order._id), fields: Object.keys(set) };
}

// One run per conversation at a time, a short pause after the latest message, and a re-run when more arrived meanwhile.
const timers = new Map(); const running = new Set(); const again = new Set();
export function scheduleAutoDraft(convId, { delayMs = config.autoDraft.delayMs, run = autoDraftForConversation, deps } = {}) {
  if (!config.autoDraft.enabled) return;
  const id = String(convId);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(async () => {
    timers.delete(id);
    if (running.has(id)) { again.add(id); return; }
    running.add(id);
    try { await run(id, deps); } catch (e) { log.warn('draft', `Could not draft an order from a conversation: ${e.message}`); }
    finally { running.delete(id); if (again.delete(id)) scheduleAutoDraft(id, { delayMs, run, deps }); }
  }, delayMs).unref?.());
}
