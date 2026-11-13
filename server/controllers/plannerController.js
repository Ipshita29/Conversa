import Order from '../models/Order.js';
import { ApiError, asyncHandler, badQuery, validationError } from '../utils/errors.js';
import { getCommitmentStart, getSettings, setCommitmentStart } from '../services/settingsService.js';
import { computePlan, publicPlan, simulate, suggestScenario } from '../services/workloadEngine.js';
import { zonedTimeToUtc } from '../utils/timezone.js';
import { isPlainObject } from '../utils/validation.js';
import { datasetOf, orderFilter } from '../utils/dataset.js';
import { scopeInputs, overview, runMove, commitmentChanges, commitmentApplied, planNow } from '../services/whatIf.js';

// `from` (YYYY-MM-DD, business timezone) may move the planning start into the future; past dates mean "now".
function planningStart(from, tz) {
  const now = new Date();
  if (!from) return now;
  const [y, m, d] = from.split('-').map(Number);
  const start = zonedTimeToUtc({ year: y, month: m, day: d }, tz);
  return start > now ? start : now;
}

function parseRange(src, fail) {
  const details = [];
  const days = src.days === undefined ? 7 : Number(src.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) details.push({ field: 'days', message: 'Must be between 1 and 30.' });
  if (src.from !== undefined && !(typeof src.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.from) && !Number.isNaN(Date.parse(src.from)))) details.push({ field: 'from', message: 'Must be a date in YYYY-MM-DD format.' });
  if (details.length) throw fail(details);
  return { days, from: src.from };
}

export const getPlanner = asyncHandler(async (req, res) => {
  const { days, from } = parseRange(req.query, badQuery);
  const dataset = datasetOf(req.query.dataset); // the Plan shows one data set: demo orders never take capacity from real ones
  const [orders, settings] = await Promise.all([Order.find(orderFilter(dataset)).limit(5000), getSettings()]);
  const now = planNow(planningStart(from, settings.timezone), await getCommitmentStart()); // an applied What-if commitment starts production at its own morning
  res.json({ ...publicPlan(computePlan({ orders, settings, now, rangeDays: days })), suggestedScenario: suggestScenario({ orders, settings, now, rangeDays: days }) });
});

export const simulatePlanner = asyncHandler(async (req, res) => {
  if (!isPlainObject(req.body)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const { days, from } = parseRange(req.body, validationError);
  const probeMinutes = req.body.probeMinutes === undefined ? 60 : req.body.probeMinutes;
  if (!Number.isInteger(probeMinutes) || probeMinutes < 15 || probeMinutes > 480) throw validationError([{ field: 'probeMinutes', message: 'Must be a whole number of minutes from 15 to 480.' }]);
  const [orders, settings] = await Promise.all([Order.find().limit(5000), getSettings()]);
  // Read-only: orders are only read, never written.
  res.json(simulate({ orders, changes: req.body.changes, settings, now: planningStart(from, settings.timezone), rangeDays: days, probeMinutes }));
});

// The What-if page. `scope` is 'commitment' (the five seeded demo orders with their requested times on one production day, planned from 9:00 that morning), 'demo' (the same orders on the real clock) or 'all' (every order); both run the same engine on copies and nothing is saved.
const scopeOf = (v) => (v === 'all' || v === 'commitment' ? v : 'demo');
const whatIfInputs = async (scope) => {
  const [orders, settings] = await Promise.all([Order.find().limit(5000), getSettings()]);
  const kind = scopeOf(scope); const raw = orders.map((o) => o.toJSON());
  return { ...scopeInputs(raw, kind, settings, new Date()), settings, raw };
};
const engineInput = ({ orders, now, settings }) => ({ orders, now, settings });
const body = (b, check) => {
  if (!isPlainObject(b)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details = check(b);
  if (details.length) throw validationError(details);
  return b;
};
export const whatIf = asyncHandler(async (req, res) => {
  const inp = await whatIfInputs(req.query.scope);
  const applied = scopeOf(req.query.scope) === 'commitment' && commitmentApplied({ orders: inp.raw, scenario: inp, storedStart: await getCommitmentStart() }); // already the Plan?
  res.json({ ...overview(engineInput(inp)), applied });
});
export const whatIfMove = asyncHandler(async (req, res) => {
  const b = body(req.body, (x) => [...(typeof x.orderId === 'string' && x.orderId ? [] : [{ field: 'orderId', message: 'Choose the order to move.' }]), ...(typeof x.deadline === 'string' ? [] : [{ field: 'deadline', message: 'Enter the proposed deadline.' }])]);
  res.json(runMove({ ...engineInput(await whatIfInputs(b.scope)), orderId: b.orderId, deadline: b.deadline }));
});

// POST /api/planner/whatif/apply  { scope: 'commitment' }
// The owner's approval of the What-if scenario. Re-derives the scenario on the server (nothing the browser says about the schedule is trusted), refuses
// one that is not feasible, then persists the commitment: the requested delivery deadlines (a deadline and nothing else on each order) and the production
// start the Plan is worked out from. Orders, payments, pictures and messages are untouched. Running a simulation never calls this.
export const applyWhatIf = asyncHandler(async (req, res) => {
  body(req.body, (x) => (x.scope === 'commitment' ? [] : [{ field: 'scope', message: "Only the 'commitment' scenario can be applied to the Plan." }]));
  const inp = await whatIfInputs('commitment');
  if (!overview(engineInput(inp)).feasible) throw new ApiError(409, 'CONFLICT', 'This schedule is not feasible, so it cannot be applied to the Plan.');
  const changed = commitmentChanges(inp.raw, inp.orders);
  for (const c of changed) await Order.updateOne({ _id: c.id }, { $set: { deadline: new Date(c.to) } });
  await setCommitmentStart(inp.now);
  res.json({ applied: true, productionStart: inp.now.toISOString(), changed });
});
