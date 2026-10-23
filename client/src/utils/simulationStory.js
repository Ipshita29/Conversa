import { formatInTz, formatMinutes } from './format.js';

// Turns the scheduler's before/after answer for ONE what-if change into plain language. Every number is read from the two schedules
// the scheduler returned for the same moment ("baseline" and "planner" in the simulate response); nothing is recalculated or capped here.
const RANK = { low: 0, medium: 1, high: 2 };
const rank = (e) => (e ? RANK[e.risk] : null);
const atRisk = (list) => list.filter((e) => e.risk !== 'low').length;
const min = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 60000);
const sooner = (m) => (m < 0 ? `${formatMinutes(-m)} sooner` : `${formatMinutes(m)} later`);

export function changeKind(change) {
  if (change.type === 'add_order') return 'rush';
  if (change.type === 'cancel_order') return 'cancel';
  return change.order && 'deadline' in change.order ? 'deadline' : 'prep';
}

export function buildStory({ change, baseline, after, byId, tz }) {
  const kind = changeKind(change);
  const targetId = change.type === 'add_order' ? 'change_0' : change.orderId;
  const before = Object.fromEntries(baseline.schedule.map((e) => [e.orderId, e]));
  const next = Object.fromEntries(after.schedule.map((e) => [e.orderId, e]));
  const orig = byId[targetId] ?? null;
  const name = (id) => (id.startsWith('change_') ? change.order.customerName : byId[id]?.customerName ?? id);
  const item = (id) => (id.startsWith('change_') ? change.order.item : byId[id]?.item ?? '');
  const T = (iso) => formatInTz(iso, tz);

  // --- 1. what the user changed
  const lines = [];
  let checked;
  if (kind === 'rush') {
    lines.push(`Add a rush order for ${name(targetId)}: ${item(targetId)}, ${formatMinutes(change.order.prepTimeMinutes)} of preparation, wanted by ${T(change.order.deadline)}.`);
    checked = 'The scheduler lines up every open order again, earliest deadline first, and checks whether the new order can finish in time without making any existing order late.';
  } else if (kind === 'deadline') {
    lines.push(`Move ${name(targetId)}'s ${item(targetId)} from ${T(orig?.deadline)} to ${T(change.order.deadline)}.`);
    checked = `The scheduler re-plans every open order with the new date and checks whether ${name(targetId)}'s order, or any other order, now finishes after its deadline.`;
  } else if (kind === 'prep') {
    lines.push(`Assume ${name(targetId)}'s ${item(targetId)} takes ${formatMinutes(change.order.prepTimeMinutes)} to prepare instead of ${formatMinutes(orig?.prepTimeMinutes)}.`);
    checked = 'The scheduler re-plans every open order with the new preparation time and checks how that changes when each order finishes.';
  } else {
    lines.push(`Cancel ${name(targetId)}'s order.`);
    checked = 'The scheduler re-plans the remaining orders and checks whether the freed time helps them.';
  }

  // --- 2. original vs proposed, side by side
  const compare = [];
  if (kind === 'rush') {
    compare.push({ label: 'Deadline', original: 'No such order yet', proposed: T(change.order.deadline) }, { label: 'Preparation time', original: '—', proposed: formatMinutes(change.order.prepTimeMinutes) });
  } else if (kind === 'deadline') {
    compare.push({ label: 'Deadline', original: T(orig?.deadline), proposed: T(change.order.deadline) });
  } else if (kind === 'prep') {
    compare.push({ label: 'Preparation time', original: formatMinutes(orig?.prepTimeMinutes), proposed: formatMinutes(change.order.prepTimeMinutes) });
  }
  const bt = before[targetId]; const at = next[targetId];
  compare.push({ label: 'Predicted finish', original: bt ? T(bt.scheduledEnd) : '—', proposed: at ? (at.scheduledEnd ? T(at.scheduledEnd) : 'Not within the planning window') : '—' });
  const bufText = (e) => (e ? (e.scheduledEnd == null ? 'Cannot be scheduled' : e.bufferMinutes < 0 ? `${formatMinutes(-e.bufferMinutes)} late` : `${formatMinutes(e.bufferMinutes)} to spare`) : '—');
  compare.push({ label: 'Buffer before the deadline', original: bufText(bt), proposed: bufText(at) });

  // --- 3. every order whose risk or finish time changes, with the reason in plain words
  const ids = [...new Set([...Object.keys(before), ...Object.keys(next)])];
  const changed = ids.filter((id) => {
    const b = before[id]; const a = next[id];
    if (!b || !a) return true;
    return rank(b) !== rank(a) || Math.abs(min(a.scheduledEnd ?? a.scheduledStart, b.scheduledEnd ?? b.scheduledStart)) >= 1;
  });
  const rows = changed.map((id) => {
    const b = before[id]; const a = next[id];
    const dir = !b || !a ? 'same' : rank(a) > rank(b) ? 'worse' : rank(a) < rank(b) ? 'better' : 'same';
    const shift = b && a && a.scheduledEnd && b.scheduledEnd ? min(a.scheduledEnd, b.scheduledEnd) : null;
    let text;
    if (id === targetId) {
      const edge = a ? (a.scheduledEnd == null ? 'It cannot be scheduled in the planning window.' : a.bufferMinutes < 0 ? `It would finish ${formatMinutes(-a.bufferMinutes)} after the deadline.` : `It would finish ${formatMinutes(a.bufferMinutes)} before the deadline.`) : '';
      if (!a) text = 'The scheduler could not place it: a preparation time and a deadline are both needed.';
      else if (kind === 'rush') text = `The new order would finish ${T(a.scheduledEnd)}. ${edge}`;
      else if (kind === 'deadline') {
        const earlier = Date.parse(change.order.deadline) < Date.parse(orig?.deadline);
        text = a.bufferMinutes >= 0 && a.risk === 'medium' ? `Moving this deadline ${earlier ? 'earlier' : 'later'} leaves only ${formatMinutes(a.bufferMinutes)} of preparation buffer.`
          : a.bufferMinutes >= 0 ? `Moving this deadline ${earlier ? 'earlier' : 'later'} still leaves ${formatMinutes(a.bufferMinutes)} of buffer, so it stays safe.`
            : `Moving this deadline ${earlier ? 'earlier' : 'later'} means the order would finish ${formatMinutes(-a.bufferMinutes)} after it. ${earlier ? 'There is not enough working time before the new date.' : ''}`.trim();
      } else if (kind === 'prep') {
        text = `${shift != null && shift !== 0 ? `It would finish ${sooner(shift)}. ` : ''}${edge}`.trim();
      } else text = '';
    } else if (!b) text = 'This order was not part of the schedule before.';
    else if (!a) text = 'This order leaves the schedule.';
    else {
      const tName = name(targetId);
      const wasAhead = (b.precededBy ?? []).some((p) => p.orderId === targetId);
      const nowAhead = (a.precededBy ?? []).some((p) => p.orderId === targetId);
      const why = !wasAhead && nowAhead ? `${tName}'s order now comes ahead of it in the queue` : wasAhead && !nowAhead ? `${tName}'s order no longer comes ahead of it` : kind === 'prep' && nowAhead ? `${tName}'s order, which comes ahead of it, takes a different amount of time` : kind === 'rush' ? 'the new order takes time before it' : 'the preparation queue ahead of it changed';
      const effect = a.scheduledEnd == null ? 'it can no longer be scheduled' : a.bufferMinutes < 0 ? `it would finish ${formatMinutes(-a.bufferMinutes)} after its deadline` : a.risk === 'medium' ? `only ${formatMinutes(a.bufferMinutes)} of buffer is left` : `it still has ${formatMinutes(a.bufferMinutes)} of buffer`;
      text = `${why[0].toUpperCase()}${why.slice(1)}, so it finishes ${shift ? sooner(shift) : 'at a slightly different time'} and ${effect}.`;
    }
    return { id, name: name(id), item: item(id), before: b ?? null, after: a ?? null, dir, shift, text, isTarget: id === targetId };
  }).sort((x, y) => (x.isTarget ? -1 : y.isTarget ? 1 : (y.dir === 'worse') - (x.dir === 'worse') || (y.dir === 'better') - (x.dir === 'better')));

  // --- 4. the one thing to take away
  const others = rows.filter((r) => !r.isTarget);
  const tgt = rows.find((r) => r.isTarget);
  const worse = others.filter((r) => r.dir === 'worse');
  const better = others.filter((r) => r.dir === 'better');
  const counts = { before: atRisk(baseline.schedule), after: atRisk(after.schedule) };
  const unschedAfter = (after.unscheduledOrders ?? []).some((u) => u.id === targetId);
  const alt = at?.risk === 'high' && at.suggestedDeadline ? { deadline: at.suggestedDeadline, label: `Try ${T(at.suggestedDeadline)} instead` } : null;
  const list = (rs) => rs.map((r) => r.name).join(', ');
  let headline;
  const target = kind === 'rush' ? 'The new order' : `${name(targetId)}'s order`;
  if (kind !== 'cancel' && (!at || unschedAfter)) {
    headline = { tone: 'details', title: 'The scheduler cannot check this', text: `${target} needs both a preparation time and a deadline before it can be placed.` };
  } else if (at?.risk === 'high' && kind !== 'cancel') {
    const late = at.scheduledEnd ? `it would finish ${T(at.scheduledEnd)}, ${formatMinutes(-at.bufferMinutes)} after the deadline` : 'it cannot be scheduled in the planning window';
    headline = {
      tone: 'high', title: kind === 'rush' ? "The new order doesn't fit by its deadline" : 'Not possible as requested',
      text: `${target} would not be finished in time: ${late}.${worse.length ? ` It also pushes ${worse.length} other ${worse.length === 1 ? 'order' : 'orders'} closer to trouble (${list(worse)}).` : ''}`,
      alternative: alt ? `A realistic alternative: set the deadline to ${T(alt.deadline)}, the earliest date the scheduler can actually meet.` : 'A realistic alternative: free up preparation time first, by postponing or declining other work.',
      alt,
    };
  } else if (worse.length) {
    headline = { tone: 'medium', title: 'This creates a conflict', text: `${kind === 'rush' ? 'The new order fits' : 'The change works for this order'}, but it pushes ${worse.length} existing ${worse.length === 1 ? 'order' : 'orders'} closer to missing their deadlines: ${list(worse)}.`, alt: null };
  } else if (tgt && tgt.dir === 'worse') {
    headline = { tone: 'medium', title: 'Still possible, but with less margin', text: `${target} would have only ${formatMinutes(at.bufferMinutes)} of buffer${bt?.bufferMinutes != null && bt.scheduledEnd ? ` (it has ${formatMinutes(bt.bufferMinutes)} now)` : ''}. No other order gets riskier. Orders at risk: ${counts.before} → ${counts.after}.`, alt: null };
  } else if (better.length || (tgt && tgt.dir === 'better')) {
    const helped = rows.filter((r) => r.dir === 'better');
    headline = { tone: 'low', title: kind === 'cancel' ? 'Cancelling frees up time' : 'This makes your orders safer', text: `${helped.length} ${helped.length === 1 ? 'order moves' : 'orders move'} to a lower risk level (${list(helped)}). Orders at risk: ${counts.before} → ${counts.after}.`, alt: null };
  } else {
    const fits = kind === 'rush' ? 'The new order fits without making any existing order late.' : 'No order gets riskier.';
    const shifted = others.filter((r) => r.shift).length;
    headline = { tone: at?.risk === 'medium' ? 'medium' : 'low', title: kind === 'rush' ? 'Yes, it fits' : 'No order changes its risk level', text: `${fits}${at?.risk === 'medium' ? ` The buffer is thin, though: ${formatMinutes(at.bufferMinutes)}.` : ''}${shifted ? ` ${shifted} other ${shifted === 1 ? 'order finishes' : 'orders finish'} at a different time, but none gets riskier.` : ''} Orders at risk: ${counts.before} → ${counts.after}.`, alt: null };
  }
  return { kind, targetId, lines, checked, compare, rows, counts, headline };
}
