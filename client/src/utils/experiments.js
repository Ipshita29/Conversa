import { buildStory } from './simulationStory.js';
import { formatInTz, formatMinutes, OPEN } from './format.js';

// Picks one experiment of each kind (a new rush order, a deadline change, a preparation-time change) for the "Suggested experiments" section.
// Nothing is invented: every proposed value starts from the scheduler's own schedule (its predicted finish times, free windows and its own
// suggested scenario), and every candidate is run through the same POST /planner/simulate the rest of the page uses before it is shown.
// A candidate that would make any other order riskier, or that does not actually help, is dropped. Nothing is saved.
const STEP = 15;                 // minutes: proposed deadlines and preparation times are rounded to a quarter hour
const DEADLINE_SLACK = 240;      // minutes of slack to ask for beyond the predicted finish; the simulation then confirms whether it is enough
const MAX_PREP_CUT = 0.25;       // never propose cutting preparation by more than a quarter, or below 30 minutes
const MIN_PREP = 30;

const up = (ms) => Math.ceil(ms / (STEP * 60000)) * STEP * 60000;
const first = (name) => (name ?? '').split(' ')[0] || 'this';

export async function findExperiments({ planner, orders, simulate, days }) {
  const tz = planner.range.timezone;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const T = (iso) => formatInTz(iso, tz);
  const entries = (planner.schedule ?? []).filter((e) => byId[e.orderId] && OPEN.includes(byId[e.orderId].status));
  const baseline = { schedule: planner.schedule ?? [], unscheduledOrders: planner.unscheduledOrders ?? [] };

  async function check(change) {
    const result = await simulate({ changes: [change], days, probeMinutes: 60 });
    const story = buildStory({ change, baseline: result.baseline ?? baseline, after: result.planner, byId, tz });
    const c = result.comparison;
    return {
      story, newRisks: c.newRisks?.length ?? 0, resolved: c.resolvedRisks?.length ?? 0,
      gain: (c.simulatedNearFreeWindow?.minutes ?? 0) - (c.currentNearFreeWindow?.minutes ?? 0),
      after: result.planner.schedule.find((e) => e.orderId === (change.type === 'add_order' ? 'change_0' : change.orderId)),
    };
  }
  const precheck = (r) => ({ tone: r.story.headline.tone, title: r.story.headline.title, text: r.story.headline.text });
  const safe = (r) => r.newRisks === 0 && r.story.headline.tone !== 'high' && r.story.headline.tone !== 'details';

  const rank = (e) => (e.risk === 'high' ? 0 : e.risk === 'medium' ? 1 : 2);
  const byUrgency = [...entries].sort((a, b) => rank(a) - rank(b) || Date.parse(a.deadline) - Date.parse(b.deadline));

  // ---- 1. Deadline change: for the most urgent order that is overdue, late or tight, ask for the scheduler's predicted finish plus some slack.
  const deadlineTask = (async () => {
    const e = byUrgency.find((x) => x.risk !== 'low' && x.scheduledEnd);
    if (!e) return { type: 'deadline', unavailable: true, reason: 'No order is overdue or at risk, so there is no deadline worth renegotiating.' };
    const o = byId[e.orderId];
    const tries = [Math.max(up(Date.parse(e.scheduledEnd) + DEADLINE_SLACK * 60000), up(Date.now() + STEP * 60000))];
    let best = null;
    for (let i = 0; i < 2 && !best; i += 1) {
      const change = { type: 'update_order', orderId: o.id, order: { deadline: new Date(tries[i]).toISOString() } };
      const r = await check(change);
      if (safe(r)) best = { change, r };
      else if (r.after?.suggestedDeadline) tries.push(up(Date.parse(r.after.suggestedDeadline))); // the scheduler's own earliest achievable date
      else break;
    }
    if (!best) return { type: 'deadline', unavailable: true, reason: `${o.customerName}'s order is ${e.kind === 'deadline_passed' ? 'overdue' : 'at risk'}, but no later deadline tested works without making another order riskier.` };
    return {
      type: 'deadline', orderId: o.id, change: best.change, urgency: e.risk === 'high' ? 30 : 12,
      title: `Move ${first(o.customerName)}'s deadline to a realistic time?`,
      summary: `Test moving the ${o.item} deadline from ${T(o.deadline)} to ${T(best.change.order.deadline)}.`,
      why: e.reason,
      tests: 'Whether a later promise date is achievable, and what it does to your other orders.',
      precheck: precheck(best.r),
    };
  })();

  // ---- 2. Preparation time: try a modest cut on every order that has room for one, and keep the one the scheduler says helps most.
  const prepTask = (async () => {
    const cands = entries.map((e) => {
      const o = byId[e.orderId]; const prep = o.prepTimeMinutes;
      if (!(prep > MIN_PREP)) return null;
      const cut = Math.min(Math.floor((prep * MAX_PREP_CUT) / STEP) * STEP, prep - MIN_PREP);
      return cut >= STEP ? { e, o, cut, change: { type: 'update_order', orderId: o.id, order: { prepTimeMinutes: prep - cut } } } : null;
    }).filter(Boolean);
    const scored = (await Promise.all(cands.map(async (c) => ({ ...c, r: await check(c.change) }))))
      .filter((c) => safe(c.r) && (c.r.resolved > 0 || c.r.gain > 0))
      .sort((a, b) => b.r.resolved - a.r.resolved || b.r.gain - a.r.gain || rank(a.e) - rank(b.e));
    return scored;
  })();

  // ---- 3. Rush order: the scheduler's own capacity check, or a 60-minute order due when the free window ends.
  const rushTask = (async () => {
    const s = planner.suggestedScenario;
    let change = s?.kind === 'capacity_check' ? s.changes[0] : null;
    let summary = s?.kind === 'capacity_check' ? s.summary : null;
    let why = s?.kind === 'capacity_check' ? s.why : null;
    if (!change) {
      const w = planner.nearFreeWindow ?? planner.largestFreeWindow;
      if (!w || w.minutes < 60) return { type: 'rush', unavailable: true, reason: 'There is no uninterrupted free hour in the next few working days, so a rush order would collide with existing work.' };
      change = { type: 'add_order', order: { customerName: 'New customer', item: 'Rush order', quantity: 1, prepTimeMinutes: 60, deadline: w.end, source: 'manual' } };
      summary = `Add a 1h order due when your free window ends (${T(w.end)}).`;
      why = `You have an uninterrupted free window of ${formatMinutes(w.minutes)}. This checks that a new order fits without hurting the others.`;
    }
    const r = await check(change);
    if (!safe(r)) return { type: 'rush', unavailable: true, reason: r.story.headline.text };
    return { type: 'rush', change, urgency: entries.some((e) => e.risk !== 'low') ? 8 : 15, title: s?.title ?? 'Could you take a 1h rush order?', summary, why, tests: 'Whether a new order fits in your free time without making any existing commitment later.', precheck: precheck(r) };
  })();

  const [deadline, prepList, rush] = await Promise.all([deadlineTask, prepTask, rushTask]);

  // Avoid suggesting the same order twice: take the best preparation candidate for a different order than the deadline one, when there is one.
  const pick = prepList.find((c) => c.o.id !== deadline.orderId) ?? prepList[0];
  let prep;
  if (!pick) prep = { type: 'prep', unavailable: true, reason: 'No order has room for a safe cut (at most a quarter, never below 30 minutes) that frees time without making another order riskier.' };
  else {
    const { e, o, cut, r } = pick; const next = o.prepTimeMinutes - cut; const sav = e.risk !== 'low';
    prep = {
      type: 'prep', orderId: o.id, change: pick.change, urgency: r.resolved > 0 ? 20 : 5 + Math.min(r.gain, 120) / 60,
      title: sav && r.resolved > 0 ? 'Could a shorter prep time save this order?' : `Could ${first(o.customerName)}'s order be prepared faster?`,
      summary: `Test ${sav && r.resolved > 0 ? 'whether reducing' : 'what happens if you reduce'} preparation time for ${first(o.customerName)}'s ${o.item} from ${formatMinutes(o.prepTimeMinutes)} to ${formatMinutes(next)}${sav && r.resolved > 0 ? ' makes the deadline achievable' : ''}.`,
      why: sav ? e.reason : `${formatMinutes(cut)} less (a quarter at most) is a modest saving. In the scheduler's pre-check it frees ${formatMinutes(r.gain)} more uninterrupted time in your next two working days.`,
      tests: 'This is an assumption, not a fact: whether the time saved is enough to matter, and who else benefits.',
      precheck: precheck(r),
    };
  }
  const all = [deadline, prep, rush];
  return all.sort((a, b) => Number(Boolean(a.unavailable)) - Number(Boolean(b.unavailable)) || (b.urgency ?? 0) - (a.urgency ?? 0));
}
