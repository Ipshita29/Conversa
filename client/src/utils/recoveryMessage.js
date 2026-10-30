import { formatInTz, OPEN } from './format.js';

// One-tap customer recovery: decides whether an order needs a heads-up, finds a revised time the scheduler can actually meet, and drafts a
// polite message from fixed templates (no external service). Nothing is sent or saved here; the owner reviews, edits and copies the text.
const STEP = 15;           // minutes: a proposed time is rounded up to a quarter hour
const SLACK = 240;         // minutes of slack asked for beyond the predicted finish; the simulation then confirms it is enough

const up = (ms) => Math.ceil(ms / (STEP * 60000)) * STEP * 60000;

// The scheduler's entry for the order decides everything; this adds no second risk engine.
export const needsRecovery = (order, entry) => Boolean(order && entry && OPEN.includes(order.status) && (entry.risk === 'high' || entry.risk === 'medium'));

export function situationOf(entry) {
  if (entry.kind === 'deadline_passed') return 'overdue';
  if (entry.kind === 'unschedulable' || entry.scheduledEnd == null) return 'unschedulable';
  if (entry.kind === 'late') return 'late';
  return 'tight';
}

// A revised delivery time for an overdue or late order, checked against the scheduler (POST /planner/simulate) before it is offered.
// Returns { kind: 'revised', deadline } | { kind: 'estimate', finish } (tight: on time, just close) | { kind: 'none', reason } (needs the owner).
export async function proposeRevision({ order, entry, simulate, days = 7, now = Date.now() }) {
  const s = situationOf(entry);
  if (s === 'tight') return { kind: 'estimate', finish: entry.scheduledEnd };
  if (s === 'unschedulable' || entry.scheduledEnd == null) return { kind: 'none', reason: 'It does not fit in the scheduler\'s planning window, so no reliable time can be offered.' };
  const tries = [Math.max(up(Date.parse(entry.scheduledEnd) + SLACK * 60000), up(now + STEP * 60000))];
  for (let i = 0; i < 2; i += 1) {
    const change = { type: 'update_order', orderId: order.id, order: { deadline: new Date(tries[i]).toISOString() } };
    let result;
    try { result = await simulate({ changes: [change], days, probeMinutes: 60 }); } catch { return { kind: 'none', reason: 'The scheduler could not check a new time just now.' }; }
    const after = result.planner.schedule.find((e) => e.orderId === order.id);
    if (after && after.risk !== 'high' && (result.comparison.newRisks?.length ?? 0) === 0) return { kind: 'revised', deadline: new Date(tries[i]).toISOString() };
    if (i === 0 && after?.suggestedDeadline) tries.push(up(Date.parse(after.suggestedDeadline))); // the scheduler's own earliest achievable time
    else break;
  }
  return { kind: 'none', reason: 'No later time tested works without making another order late. This one needs your judgement.' };
}

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
export const customerFirstName = (order) => clean(order?.customerName).split(' ')[0] || 'there';
const itemText = (order) => {
  const i = clean(order?.item) || 'order';
  const item = /^[A-Z][a-z]/.test(i) ? i[0].toLowerCase() + i.slice(1) : i; // "Wedding favours" reads as "your wedding favours"
  return order?.quantity > 1 ? `${item} (× ${order.quantity})` : item;
};

const TEMPLATES = {
  overdue: [
    ({ n, item, t }) => `Hi ${n}, I'm sorry, but your ${item} is taking longer than we promised. Would delivery at ${t} work for you? Thank you for your patience!`,
    ({ n, item, t }) => `Hi ${n}, apologies for the delay with your ${item}. The earliest I can now confirm is ${t}. Please let me know if that suits you, or if another time would be better.`,
    ({ n, item, t, orig }) => `Hello ${n}, I owe you an apology: your ${item} was due ${orig} and isn't with you yet. I can have it ready by ${t}. Does that work?`,
  ],
  overdueNoTime: [
    ({ n, item, orig }) => `Hi ${n}, I'm sorry, your ${item} is running behind the ${orig} time we promised. What time would suit you best? I'll do everything I can to make it work.`,
    ({ n, item }) => `Hi ${n}, apologies for the delay with your ${item}. Could we agree on a new delivery time? Let me know what works for you and I'll confirm it right away.`,
    ({ n, item, orig }) => `Hello ${n}, your ${item} missed its ${orig} slot and I'm sorry about that. Would you be open to telling me a time that suits you so I can plan around it?`,
  ],
  late: [
    ({ n, item, t, orig }) => `Hi ${n}, a quick heads-up on your ${item}: it's taking a little longer than planned and may not be ready by ${orig}. Would ${t} work instead? Thank you for understanding!`,
    ({ n, item, t }) => `Hi ${n}, I want to be upfront early: your ${item} is likely to need a little more time. Could we move delivery to ${t}? Happy to talk it through.`,
    ({ n, item, t, orig }) => `Hello ${n}, to avoid any surprise: ${item} looks unlikely to be ready by ${orig}. I can offer ${t}. Does that suit you?`,
  ],
  lateNoTime: [
    ({ n, item, orig }) => `Hi ${n}, a quick heads-up on your ${item}: it may not be ready by ${orig}. Would you be open to a slightly later time? Let me know what would suit you.`,
    ({ n, item }) => `Hi ${n}, I want to be upfront early: I may need a bit more time for your ${item}. Could we agree on a different delivery time that works for you?`,
    ({ n, item, orig }) => `Hello ${n}, I'm not sure I can finish ${item} by ${orig}. Could we talk about an alternative time that works for you?`,
  ],
  tight: [
    ({ n, item, finish, orig }) => `Hi ${n}, a quick update on your ${item}: it's on track for ${orig}, with the schedule fairly tight (I expect it ready around ${finish}). I'll tell you straight away if anything changes.`,
    ({ n, item, orig }) => `Hi ${n}, just letting you know your ${item} is in progress for ${orig}. Timing is close, so I'll keep you posted. Thanks for your patience!`,
    ({ n, item, finish }) => `Hello ${n}, your ${item} is on schedule (expected around ${finish}), though with little margin. I'll update you if that moves.`,
  ],
};

// `variant` picks the wording (Regenerate moves to the next one). `revision` comes from proposeRevision (or with an edited deadline).
export function buildMessage({ order, entry, revision, tz, variant = 0 }) {
  const s = situationOf(entry);
  const T = (iso) => formatInTz(iso, tz);
  const vars = { n: customerFirstName(order), item: itemText(order), orig: order?.deadline ? T(order.deadline) : 'the agreed time', t: revision?.kind === 'revised' ? T(revision.deadline) : '', finish: entry.scheduledEnd ? T(entry.scheduledEnd) : '' };
  const key = s === 'tight' ? 'tight' : s === 'overdue' ? (revision?.kind === 'revised' ? 'overdue' : 'overdueNoTime') : (revision?.kind === 'revised' ? 'late' : 'lateNoTime');
  const list = TEMPLATES[key];
  return { text: list[((variant % list.length) + list.length) % list.length](vars), count: list.length, key };
}

// Clipboard copy with proper outcome reporting. `clipboard` and `fallback` are injectable so both paths can be tested.
export async function copyText(text, { clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined, fallback } = {}) {
  try {
    if (clipboard?.writeText) { await clipboard.writeText(text); return { ok: true }; }
  } catch { /* fall through to the fallback */ }
  try { if (fallback && fallback(text)) return { ok: true }; } catch { /* reported below */ }
  return { ok: false };
}
