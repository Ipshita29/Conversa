import Order from '../models/Order.js';
import { asyncHandler, badQuery, validationError } from '../utils/errors.js';
import { getSettings } from '../services/settingsService.js';
import { computePlan, publicPlan, simulate, suggestScenario } from '../services/workloadEngine.js';
import { zonedTimeToUtc } from '../utils/timezone.js';
import { isPlainObject } from '../utils/validation.js';
import { scopeOrders, scopeNow, overview, runMove } from '../services/whatIf.js';

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
  const [orders, settings] = await Promise.all([Order.find().limit(5000), getSettings()]);
  const now = planningStart(from, settings.timezone);
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

// The What-if page. `scope` is 'commitment' (the five seeded demo orders planned from 9:00 on the scenario day), 'demo' (the same orders on the real clock) or 'all' (every order); both run the same engine on copies and nothing is saved.
const scopeOf = (v) => (v === 'all' || v === 'commitment' ? v : 'demo');
const whatIfInputs = async (scope) => {
  const [orders, settings] = await Promise.all([Order.find().limit(5000), getSettings()]);
  const kind = scopeOf(scope);
  return { orders: scopeOrders(orders.map((o) => o.toJSON()), kind), settings, now: scopeNow(kind, settings, new Date()) };
};
const body = (b, check) => {
  if (!isPlainObject(b)) throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details = check(b);
  if (details.length) throw validationError(details);
  return b;
};
export const whatIf = asyncHandler(async (req, res) => res.json(overview(await whatIfInputs(req.query.scope))));
export const whatIfMove = asyncHandler(async (req, res) => {
  const b = body(req.body, (x) => [...(typeof x.orderId === 'string' && x.orderId ? [] : [{ field: 'orderId', message: 'Choose the order to move.' }]), ...(typeof x.deadline === 'string' ? [] : [{ field: 'deadline', message: 'Enter the proposed deadline.' }])]);
  res.json(runMove({ ...(await whatIfInputs(b.scope)), orderId: b.orderId, deadline: b.deadline }));
});
