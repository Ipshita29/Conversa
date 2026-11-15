import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarCheck, Check, ChevronDown, FlaskConical, Layers, Zap, Pencil, Info, PenLine, Clock, Plus, RotateCcw } from 'lucide-react';
import useAsync from '../hooks/useAsync.js';
import { DEMO_MODE, getConversations, getIntegrations, getWhatIf, simulateMove, applyWhatIf, updateOrder, createOrder, simulatePlanner } from '../services/api.js';
import { summarise } from '../utils/homeSummary.js';
import { formatDayInTz, formatInTz, formatMinutes, formatTimeInTz, STATUS_LABEL, formatLongInTz, fromLocalInput, toLocalInput, isoToLocalInput, localInputToIso } from '../utils/format.js';
import { useId, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import DeckStage from './DeckStage.jsx';
import { zonedParts, zonedTimeToUtc } from '../../../server/utils/timezone.js';
import { SectionHead } from './Layout.jsx';
import { RiskBadge, Modal, StateMessage, CountUp } from './UI.jsx';
import { validateOrder } from '../utils/validateOrder.js';
import { rushImpact } from '../utils/roadmap.js';
import '../css/Workspace.css';

// ======== Day workspace, risk and connections ========

// ---------- DayWorkspace ----------
const plural = (n, one, many) => (n === 1 ? one : many);
const MISSING = { missing_prep_time: 'preparation time', missing_deadline: 'deadline', missing_both: 'preparation time and deadline' };
const MAX_ISSUES = 3;
const MAX_UPCOMING = 3;

// Under the hero: how busy am I, what needs attention, what should I do next. Everything is derived from the planner and orders
// the API already returns (see utils/homeSummary.js); the scheduler's own ranking decides what comes first.
export function DayWorkspace({ planner, orders }) {
  const conv = useAsync(getConversations); // optional: only to link an order to its chat
  const { tz, today, byId, open, todayIds, issues, riskIds, attention, nextDeadline, top } = summarise({ planner, orders });
  const entry = Object.fromEntries(planner.schedule.map((e) => [e.orderId, e]));
  const chatOf = Object.fromEntries((conv.data?.items ?? []).filter((c) => c.orderId).map((c) => [c.orderId, c.id]));
  const unscheduledReason = Object.fromEntries(planner.unscheduledOrders.map((u) => [u.id, u.reason]));

  if (orders.length === 0) return <StateMessage message="No orders yet. Add your first order, or draft one from a customer message."><Link className="btn btn-primary" to="/orders">Go to Orders</Link></StateMessage>;

  const attentionTo = riskIds.size > 0 ? '/plan?focus=risk' : '/plan?focus=missing';
  const metrics = [
    { key: 'today', label: 'Orders', value: todayIds.size, to: '/plan' },
    { key: 'attn', label: 'At risk', value: riskIds.size, to: attention ? attentionTo : '/plan', tone: riskIds.size ? 'risk' : null },
    { key: 'next', label: 'Next deadline', value: nextDeadline ? formatInTz(nextDeadline.deadline, tz) : 'None upcoming', note: nextDeadline ? `${nextDeadline.customerName} · ${nextDeadline.item}` : null, to: nextDeadline ? `/orders?edit=${nextDeadline.id}` : '/orders', small: true },
  ];

  // One short line per order: what is wrong, with the exact deadline kept beside it.
  const issueRows = issues.slice(0, MAX_ISSUES).map((m) => {
    const o = byId[m.orderId]; const e = entry[m.orderId];
    const missing = m.kind === 'needs_details';
    const state = missing ? `Missing ${MISSING[unscheduledReason[m.orderId]] ?? 'details'}`
      : m.kind === 'deadline_passed' ? 'Overdue' : m.kind === 'tight' ? `Tight, ${formatMinutes(e?.bufferMinutes)} to spare` : m.kind === 'late' ? `Late by ${formatMinutes(e?.shortfallMinutes)}` : 'Cannot be scheduled';
    return { m, o, missing, state, tone: missing ? 'info' : m.kind === 'tight' ? 'warn' : 'late' };
  });
  const attnTitle = issueRows.length && issueRows.every((r) => r.m.kind === 'deadline_passed') ? 'Overdue' : issueRows.length && issueRows.every((r) => !r.missing && r.m.kind !== 'deadline_passed') ? 'At risk' : 'Needs review';

  const REASON = { deadline_passed: 'Deadline missed', late: 'Running late', tight: 'Tight deadline', needs_details: 'Missing details' };
  const nextStep = top ? (() => {
    const o = byId[top.orderId];
    const contact = (top.kind === 'deadline_passed' || top.kind === 'late') && chatOf[top.orderId];
    const who = o.customerName.split(' ')[0];
    return {
      top, o, to: contact ? `/inbox?conversation=${chatOf[top.orderId]}` : `/orders?edit=${top.orderId}`,
      label: contact ? 'Open conversation' : top.kind === 'needs_details' ? 'Add details' : 'Review order',
      title: contact ? `Contact ${who}` : top.kind === 'needs_details' ? `Complete ${who}'s order` : `Review ${who}'s order`,
      detail: `${o.item}${o.quantity > 1 ? ` × ${o.quantity}` : ''} · ${REASON[top.kind] ?? 'Needs attention'}`,
    };
  })() : null;

  const first = new Map();
  for (const d of planner.days) for (const b of d.orders) if (byId[b.id] && !first.has(b.id)) first.set(b.id, { ...b, date: d.date });
  const upcoming = [...first.values()].filter((r) => !riskIds.has(r.id) || entry[r.id]?.kind !== 'deadline_passed').sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, MAX_UPCOMING);

  return (
    <div className="dw">
      <SectionHead eyebrow="Today" title="Your day, at a glance." />
      <dl className="dw-metrics">
        {metrics.map((x) => (
          <Link key={x.key} to={x.to} className={`dw-metric${x.tone ? ` is-${x.tone}` : ''}`}>
            <dt>{x.label}</dt>
            <dd className={x.small ? 'is-small' : ''}>{x.value}</dd>
            {x.note && <small>{x.note}</small>}
          </Link>
        ))}
      </dl>

      <div className="dw-cols">
        <div className="dw-left">
          <section className="dw-sec" aria-labelledby="dw-attn">
            <div className="dw-sec-head"><h3 id="dw-attn">{attnTitle}</h3>{attention > MAX_ISSUES && <Link to={attentionTo} className="dw-all">View all {attention} <ArrowRight size={14} aria-hidden="true" /></Link>}</div>
            {issueRows.length === 0 ? (
              <p className="dw-clear"><Check size={16} aria-hidden="true" /> All caught up.</p>
            ) : (
              <ul className="dw-issues">
                {issueRows.map(({ m, o, missing, state, tone }) => (
                  <li key={m.orderId} className={`dw-issue is-${tone}`}>
                    <span className="dw-bar" aria-hidden="true" />
                    <div className="dw-issue-main">
                      <p><strong>{o.customerName}</strong><span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></p>
                      <p className="dw-reason">{state}{o.deadline && !missing && <> · <time dateTime={o.deadline}>{formatInTz(o.deadline, tz)}</time></>}</p>
                    </div>
                    <Link to={`/orders?edit=${o.id}`} className="dw-act">{missing ? 'Add details' : 'Review'} <ArrowRight size={14} aria-hidden="true" /></Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="dw-sec dw-upcoming" aria-labelledby="dw-up">
            <div className="dw-sec-head"><h3 id="dw-up">Coming up</h3><Link to="/plan" className="dw-all">Full schedule <ArrowRight size={14} aria-hidden="true" /></Link></div>
            {upcoming.length === 0 ? <p className="dw-empty">Nothing is scheduled yet.</p> : (
              <ol className="dw-up">
                {upcoming.map((r) => { const o = byId[r.id]; const e = entry[r.id]; return (
                  <li key={r.id}>
                    <time dateTime={r.start}><b>{formatTimeInTz(r.start, tz)}</b><span>{r.date === today ? 'Today' : formatDayInTz(r.date)}</span></time>
                    <div><strong>{o.customerName}</strong><span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></div>
                    <span className={`dw-status${e?.risk === 'high' ? ' is-late' : e?.risk === 'medium' ? ' is-warn' : ''}`}>{e?.risk === 'high' ? 'At risk' : e?.risk === 'medium' ? 'Tight' : STATUS_LABEL[o.status]}</span>
                  </li>); })}
              </ol>
            )}
          </section>
        </div>

        <aside className="dw-next" aria-labelledby="dw-next">
          {nextStep ? (
            <>
              <p className="dw-label" id="dw-next">Suggested action</p>
              <p className="dw-next-action">{nextStep.title}</p>
              <p className="dw-next-why">{nextStep.detail}</p>
              <Link to={nextStep.to} className="btn btn-primary">{nextStep.label} <ArrowRight size={16} aria-hidden="true" /></Link>
            </>
          ) : <p className="dw-clear" id="dw-next">Nothing is waiting on you.</p>}
        </aside>
      </div>
    </div>
  );
}

// ---------- RiskTimeline ----------
// Draws ONLY what the scheduler returned: each day's capacity window (startsAt + capacityMinutes) and the exact
// time blocks it placed. Earlier orders = caramel, this order = blue, the part after the deadline = muted red.
export function RiskTimeline({ entry, planner, tz }) {
  const deadline = entry.deadline ? Date.parse(entry.deadline) : null;
  const days = [...new Set((entry.blocks ?? []).map((b) => b.date))]
    .map((date) => planner.days.find((d) => d.date === date))
    .filter((d) => d && d.startsAt && d.capacityMinutes > 0);
  if (days.length === 0) return null; // no scheduler detail for these days: show nothing rather than guess

  const shownDays = days.slice(0, 5);
  return (
    <figure className="tl" aria-label="Where this order sits in your working days">
      <figcaption>Where it sits in your working days <small>(times in {tz})</small></figcaption>
      {shownDays.map((day) => {
        const t0 = Date.parse(day.startsAt);
        const span = day.capacityMinutes * 60000;
        const pct = (t) => Math.max(0, Math.min(100, ((t - t0) / span) * 100));
        const segs = [];
        for (const o of day.orders) {
          const s = Date.parse(o.start); const e = Date.parse(o.end);
          if (o.id !== entry.orderId) { segs.push({ kind: 'other', left: pct(s), width: pct(e) - pct(s), label: `${o.customerName} · ${formatMinutes(o.scheduledMinutes)}` }); continue; }
          const cut = deadline === null ? e : Math.max(s, Math.min(e, deadline));
          if (cut > s) segs.push({ kind: 'self', left: pct(s), width: pct(cut) - pct(s), label: `This order · ${formatMinutes(Math.round((cut - s) / 60000))}` });
          if (e > cut) segs.push({ kind: 'late', left: pct(cut), width: pct(e) - pct(cut), label: `After the deadline · ${formatMinutes(Math.round((e - cut) / 60000))}` });
        }
        const marker = deadline !== null && deadline >= t0 && deadline <= t0 + span ? pct(deadline) : null;
        const summary = `${formatDayInTz(day.date)}: ${segs.map((s) => s.label).join('; ')}${marker !== null ? '; the deadline falls on this day' : ''}`;
        return (
          <div key={day.date} className="tl-day">
            <span className="tl-label">{formatDayInTz(day.date)}<small>{formatMinutes(day.plannedMinutes)} of {formatMinutes(day.capacityMinutes)} booked</small></span>
            <div className="tl-bar" role="img" aria-label={summary}>
              {segs.map((s, i) => <i key={i} className={`tl-seg tl-${s.kind}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} title={s.label} />)}
              {marker !== null && <b className="tl-deadline" style={{ left: `${marker}%` }} title="Promised deadline" />}
            </div>
          </div>
        );
      })}
      {days.length > shownDays.length && <p className="muted tl-more">+{days.length - shownDays.length} more working {days.length - shownDays.length === 1 ? 'day' : 'days'}</p>}
      <ul className="tl-legend">
        <li><i className="tl-seg tl-other" /> Earlier orders</li>
        <li><i className="tl-seg tl-self" /> This order</li>
        <li><i className="tl-seg tl-late" /> After the deadline</li>
        <li><i className="tl-deadline-key" /> Promised deadline</li>
      </ul>
    </figure>
  );
}

// ---------- RiskSection ----------
const qty = (o) => (o.quantity > 1 ? ` × ${o.quantity}` : '');

// Urgency: biggest predicted lateness first; overdue / unschedulable lead; then tightest buffers.
const urgency = (e) => (e.kind === 'deadline_passed' || e.kind === 'unschedulable' ? Infinity : e.shortfallMinutes ?? -(e.bufferMinutes ?? 0));
const byUrgency = (a, b) => urgency(b) - urgency(a) || (a.deadline ?? '').localeCompare(b.deadline ?? '');

function impact(e) {
  if (e.kind === 'deadline_passed') return { text: 'Past due', tone: 'late' };
  if (e.kind === 'unschedulable') return { text: 'Cannot be scheduled', tone: 'late' };
  if (e.bufferMinutes === null || e.bufferMinutes === undefined) return null;
  return e.bufferMinutes < 0 ? { text: `${formatMinutes(-e.bufferMinutes)} late`, tone: 'late' } : { text: `${formatMinutes(e.bufferMinutes)} to spare`, tone: e.risk === 'medium' ? 'tight' : 'ok' };
}

function impactSentence(e, buf) {
  if (e.kind === 'deadline_passed') return 'The promised deadline has already passed.';
  if (e.kind === 'unschedulable') return e.reason;
  if (e.bufferMinutes === null || e.bufferMinutes === undefined) return e.reason;
  if (e.bufferMinutes < 0) return `Expected to finish ${formatMinutes(-e.bufferMinutes)} after the promised deadline.`;
  return `Expected to finish ${formatMinutes(e.bufferMinutes)} before the promised deadline${e.risk === 'medium' ? `, which is less than the ${formatMinutes(buf)} safety buffer` : ''}.`;
}

function Row({ order, entry, tz, planner, byId, rec, recLabel = 'Recommended', buf, onSimulate }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const imp = impact(entry);
  const risky = entry.risk !== 'low';
  const ahead = (entry.precededBy ?? []).filter((p) => byId[p.orderId]);
  const aheadMinutes = ahead.reduce((s, p) => s + p.minutes, 0);
  const finish = entry.scheduledEnd;

  return (
    <li className={`rk rk-${entry.risk}${open ? ' is-open' : ''}`}>
      <div className="rk-head">
        <div className="rk-who"><strong>{order.customerName}</strong><span>{order.item}{qty(order)}</span></div>
        <div className="rk-when"><small>Promised deadline</small>{order.deadline ? formatInTz(order.deadline, tz) : '—'}</div>
        <div className="rk-when"><small>Predicted finish</small>{finish ? formatInTz(finish, tz) : entry.kind === 'unschedulable' ? 'Not within the horizon' : '—'}</div>
        <div className={`rk-impact rk-impact-${imp?.tone ?? 'ok'}`}>{imp?.text ?? '—'}</div>
        <RiskBadge risk={entry.risk} />
        <button type="button" className="rk-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {risky ? 'Why is this at risk?' : 'Details'} <ChevronDown size={15} aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div id={id} className="rk-body">
          <div className="rk-compare">
            <div><small>Promised deadline</small><b>{formatLongInTz(order.deadline, tz)}</b></div>
            <ArrowRight size={20} className="rk-arrow" aria-hidden="true" />
            <div className={entry.risk === 'high' ? 'is-late' : ''}><small>Expected finish</small><b>{finish ? formatLongInTz(finish, tz) : 'Not within the planning horizon'}</b></div>
          </div>
          <p className={`rk-sentence rk-sentence-${entry.risk}`}>{impactSentence(entry, buf)}</p>

          <div className="rk-cols">
            <div>
              <h4>{risky ? 'Why is this at risk?' : 'How it was scheduled'}</h4>
              <ul className="rk-why">
                <li>{entry.reason}</li>
                <li>Needs {formatMinutes(entry.prepTimeMinutes ?? order.prepTimeMinutes)} of preparation; work is planned to start {formatInTz(entry.scheduledStart, tz)}.</li>
                {ahead.length > 0 ? (
                  <li>
                    Scheduled behind {ahead.length} {plural(ahead.length, 'order', 'orders')} with earlier deadlines ({formatMinutes(aheadMinutes)} of preparation):{' '}
                    {ahead.map((p, i) => <span key={p.orderId}>{i > 0 && ', '}{byId[p.orderId].customerName} ({formatMinutes(p.minutes)})</span>)}.
                  </li>
                ) : entry.precededBy ? <li>No other order is scheduled ahead of it.</li> : null}
              </ul>
            </div>

            {risky && (
              <div>
                <h4>Practical recovery</h4>
                {entry.suggestedDeadline && (
                  <div className="rk-suggest">
                    <small>Suggested deadline · a recommendation, not a change</small>
                    <b>{formatLongInTz(entry.suggestedDeadline, tz)}</b>
                    <span>The customer's promised deadline stays {formatInTz(order.deadline, tz)} unless you change it.</span>
                  </div>
                )}
                {rec && <p className="rk-rec"><b>{recLabel}:</b> {rec}</p>}
                <div className="rk-actions">
                  {onSimulate && <button type="button" className="btn btn-sm btn-primary" onClick={() => onSimulate({ orderId: order.id, deadline: entry.suggestedDeadline ?? order.deadline })}><FlaskConical size={14} aria-hidden="true" />{entry.suggestedDeadline ? 'Try the suggested deadline' : 'Simulate a schedule change'}</button>}
                  <Link className="btn btn-sm" to={`/orders?edit=${order.id}`}><Pencil size={14} aria-hidden="true" />Edit this order</Link>
                </div>
              </div>
            )}
          </div>

          <RiskTimeline entry={entry} planner={planner} tz={tz} />
        </div>
      )}
    </li>
  );
}

function RulesDialog({ buf, onClose }) {
  const b = formatMinutes(buf);
  return (
    <Modal title="How is risk calculated?" onClose={onClose}>
      <p className="muted rules-intro">Conversa's scheduler places your open orders earliest-deadline-first inside your working hours and daily capacity, then compares each order's expected finish with its promised deadline.</p>
      <dl className="rules">
        <div><dt><RiskBadge risk="high" /></dt><dd>The expected finish is after the deadline, or the deadline has already passed.</dd></div>
        <div><dt><RiskBadge risk="medium" /></dt><dd>It finishes on time, but with less than {b} of buffer.</dd></div>
        <div><dt><RiskBadge risk="low" /></dt><dd>It finishes on time with at least {b} of buffer.</dd></div>
        <div><dt><RiskBadge needsDetails /></dt><dd>Preparation time or deadline is missing, so the order cannot be reliably scheduled. It is never given a guessed finish time or risk.</dd></div>
      </dl>
      <p className="muted rules-foot">Completed and cancelled orders are ignored. Today only counts the working time that is left.</p>
    </Modal>
  );
}

// Everything shown is the scheduling engine's output (planner API); nothing is recalculated in the browser.
export function RiskSection({ planner, orders, onSimulate, eyebrow = 'Orders at risk', title = "Let's protect your deadlines.", subtitle = 'See which orders need attention, what is causing the conflict, and what you can do next.' }) {
  const [rules, setRules] = useState(false);
  const tz = planner.range.timezone;
  const buf = planner.rules?.riskBufferMinutes ?? 240;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const schedule = (planner.schedule ?? []).filter((e) => byId[e.orderId]);
  // The engine's own recovery suggestion for the order (planner.nextMoves); older responses fall back to its recommendation.
  const recovery = (id) => (planner.nextMoves ?? []).find((m) => m.orderId === id)?.recovery ?? null;
  const recFor = (id) => recovery(id) ?? planner.recommendations.find((r) => r.orderId === id)?.action ?? null;
  const recLabelFor = (id) => (recovery(id) ? 'Recovery' : 'Recommended');

  const high = schedule.filter((e) => e.risk === 'high').sort(byUrgency);
  const medium = schedule.filter((e) => e.risk === 'medium').sort(byUrgency);
  const low = schedule.filter((e) => e.risk === 'low');
  const details = planner.unscheduledOrders.filter((u) => byId[u.id]);
  const overdue = high.filter((e) => e.kind === 'deadline_passed').length;
  const predicted = high.length - overdue;

  const sentences = [];
  if (predicted > 0) sentences.push(`${predicted} ${plural(predicted, 'order is', 'orders are')} predicted to miss ${plural(predicted, 'its deadline', 'their deadlines')}.`);
  if (overdue > 0) sentences.push(`${overdue} ${plural(overdue, 'order is', 'orders are')} already past due.`);
  if (predicted + overdue === 0 && medium.length > 0) sentences.push(`No orders are predicted to miss their deadlines, but ${medium.length} ${plural(medium.length, 'has', 'have')} less than ${formatMinutes(buf)} of buffer.`);
  if (high.length + medium.length === 0 && low.length > 0) sentences.push(low.length === 1 ? 'Your scheduled order is on track.' : `All ${low.length} scheduled orders are on track.`);
  if (details.length > 0) sentences.push(`${details.length} ${plural(details.length, 'order needs', 'orders need')} details before ${plural(details.length, 'it', 'they')} can be scheduled.`);
  const total = high.length + medium.length + low.length + details.length;

  const rulesButton = <button type="button" className="rk-rules-link" onClick={() => setRules(true)}><Info size={14} aria-hidden="true" /> How is risk calculated?</button>;

  return (
    <>
      <SectionHead eyebrow={eyebrow} title={title} action={rulesButton}>{subtitle}</SectionHead>
      {total === 0 ? (
        <StateMessage message="No open orders to schedule." />
      ) : (
        <>
          {sentences.length > 0 && <p className="sr-only" aria-live="polite">{sentences.join(' ')}</p>}
          <dl className="rk-overview" aria-label="Risk overview">
            <div className="rk-ov rk-ov-high"><dt>High risk</dt><dd><CountUp value={high.length} /></dd><small>{overdue > 0 ? `${overdue} already past due` : 'Predicted to miss the deadline'}</small></div>
            <div className="rk-ov rk-ov-medium"><dt>Tight buffer</dt><dd><CountUp value={medium.length} /></dd><small>Under {formatMinutes(buf)} to spare</small></div>
            <div className="rk-ov rk-ov-low"><dt>On track</dt><dd><CountUp value={low.length} /></dd><small>{formatMinutes(buf)} or more to spare</small></div>
            <div className="rk-ov rk-ov-details"><dt>Needs details</dt><dd><CountUp value={details.length} /></dd><small>Can't be scheduled yet</small></div>
          </dl>

          {high.length > 0 && (
            <section className="rk-group rk-group-high" aria-label="High risk">
              <h3>High risk <span>{high.length}</span></h3>
              <p>Predicted to miss the promised deadline, or already past it. Most urgent first.</p>
              <ol className="rk-list">{high.map((e) => <Row key={e.orderId} order={byId[e.orderId]} entry={e} tz={tz} planner={planner} byId={byId} rec={recFor(e.orderId)} recLabel={recLabelFor(e.orderId)} buf={buf} onSimulate={onSimulate} />)}</ol>
            </section>
          )}

          {medium.length > 0 && (
            <section className="rk-group rk-group-medium" aria-label="Tight buffer">
              <h3>Tight buffer <span>{medium.length}</span></h3>
              <p>On time, but with less than {formatMinutes(buf)} of safety buffer.</p>
              <ol className="rk-list">{medium.map((e) => <Row key={e.orderId} order={byId[e.orderId]} entry={e} tz={tz} planner={planner} byId={byId} rec={recFor(e.orderId)} recLabel={recLabelFor(e.orderId)} buf={buf} onSimulate={onSimulate} />)}</ol>
            </section>
          )}

          {details.length > 0 && (
            <section className="rk-group rk-group-details" aria-label="Needs details">
              <h3>Needs details <span>{details.length}</span></h3>
              <p className="muted">Left out of scheduling until complete. Nothing is guessed: no finish time and no risk is assigned.</p>
              <ul className="rk-list">
                {details.map((u) => {
                  const o = byId[u.id];
                  return (
                    <li key={u.id} className="rk rk-details">
                      <div className="rk-head rk-head-details">
                        <div className="rk-who"><strong>{o.customerName}</strong><span>{o.item}{qty(o)}</span></div>
                        <div className="rk-when"><small>Missing</small>{MISSING[u.reason]}</div>
                        <div className="rk-when"><small>Promised deadline</small>{o.deadline ? formatInTz(o.deadline, tz) : 'Not set'}</div>
                        <RiskBadge needsDetails />
                        <Link className="btn btn-sm btn-primary" to={`/orders?edit=${o.id}`}>Complete order details</Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {low.length > 0 && (
            <section className="rk-group rk-group-low" aria-label="On track">
              <h3>On track <span>{low.length}</span></h3>
              <ol className="rk-list">{low.map((e) => <Row key={e.orderId} order={byId[e.orderId]} entry={e} tz={tz} planner={planner} byId={byId} rec={null} buf={buf} />)}</ol>
            </section>
          )}
        </>
      )}
      {rules && <RulesDialog buf={buf} onClose={() => setRules(false)} />}
    </>
  );
}

// ---------- ConnectSection ----------
const FEATURES = [
  { Icon: Zap, label: 'Auto capture orders' },
  { Icon: CalendarCheck, label: 'Keep your day planned' },
  { Icon: Layers, label: 'All channels in one place' },
];
const ROADMAP = [
  { key: 'instagram', name: 'Instagram', Logo: InstagramLogo },
  { key: 'messenger', name: 'Facebook Messenger', Logo: MessengerLogo },
  { key: 'shopify', name: 'Shopify', Logo: ShopifyLogo },
  { key: 'woocommerce', name: 'WooCommerce', Logo: WooCommerceLogo },
];
const COUNTRY_CODES = [['+1', 'US'], ['+44', 'UK'], ['+91', 'IN'], ['+61', 'AU'], ['+49', 'DE'], ['+33', 'FR'], ['+971', 'AE'], ['+65', 'SG']];

// The WhatsApp panel shows the real connection state. The number form is an onboarding preview: it never calls the API, so the
// account that is already connected is never replaced or reset.
export function ConnectSection() {
  const integ = useAsync(getIntegrations, []);
  const wa = (integ.data?.items ?? []).find((i) => i.channel === 'whatsapp');
  const state = DEMO_MODE ? 'not_connected' : wa?.state ?? null;
  const label = state === 'connected' ? 'Connected' : state === 'needs_attention' || state === 'expired' ? 'Needs attention' : state ? 'Not connected' : 'Checking…';
  const [code, setCode] = useState('+1');
  const [number, setNumber] = useState('');
  const [note, setNote] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    const digits = number.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 14) { setNote({ ok: false, text: 'Enter a valid WhatsApp Business number.' }); return; }
    setNote({ ok: true, text: 'Your WhatsApp Business account is already connected, so nothing was changed. Adding further numbers is coming soon.' });
  };
  return (
    <div className="cx">
      <h2 className="cx-lead">Bring your conversations together.</h2>
      <div className="cx-body">
        <div className="cx-intro">
          <p className="eyebrow">Channels</p>
          <h3 className="cx-title">Your conversations. <em>One workspace.</em></h3>
          <p className="cx-text">Connect your business channels, starting with WhatsApp, so customer messages and order requests flow into Conversa automatically.</p>
          <ul className="cx-features">
            {FEATURES.map(({ Icon, label: text }) => <li key={text}><span aria-hidden="true"><Icon size={16} /></span>{text}</li>)}
          </ul>
          <Link to="/orders?edit=new" className="cx-manual"><PenLine size={14} aria-hidden="true" /> Add an order manually</Link>
        </div>

        <div className="cx-side">
          <section className="cx-wa" aria-label="WhatsApp Business">
            <div className="cx-wa-head">
              <WhatsAppLogo size={44} />
              <h4>WhatsApp Business <span className={`cx-status${state === 'connected' ? ' is-on' : state === 'needs_attention' || state === 'expired' ? ' is-warn' : ''}`}>{label}</span></h4>
            </div>
            <p className="cx-purpose">{state === 'connected' ? 'Conversa is currently connected to your WhatsApp Business number.' : 'Connect your WhatsApp Business number to bring customer messages into Conversa.'}</p>
            <form className="cx-form" onSubmit={submit} noValidate>
              <div className="cx-phone">
                <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="Country code">
                  {COUNTRY_CODES.map(([c, n]) => <option key={c} value={c} title={n}>{c}</option>)}
                </select>
                <input type="tel" inputMode="tel" autoComplete="tel-national" value={number} onChange={(e) => { setNumber(e.target.value); setNote(null); }} placeholder="Enter your WhatsApp Business number" aria-label="WhatsApp Business number" />
              </div>
              <button type="submit" className="btn btn-primary">Connect to Conversa <ArrowRight size={16} aria-hidden="true" /></button>
            </form>
            {note && <p className={`cx-note ${note.ok ? 'is-ok' : 'is-bad'}`} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
            <p className="cx-help">Add your WhatsApp Business number to start receiving and managing orders in Conversa.</p>
          </section>

          <section className="cx-future" aria-label="Future integrations">
            <p className="cx-future-tag">Future plan</p>
            <h4>02. Expand the business ecosystem</h4>
            <p className="cx-purpose">Connect additional sales channels, online storefronts, and order-management tools — such as Facebook Messenger, Shopify, and WooCommerce — into one intelligent workspace.</p>
            <ul className="cx-roadmap">
              {ROADMAP.map(({ key, name, Logo }) => <li key={key}><Logo size={28} />{name}</li>)}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------- ChannelLogos ----------
// Brand marks drawn as inline SVG (lucide-react ships no brand logos, and no icon package with them is installed).
export function WhatsAppLogo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="WhatsApp">
      <circle cx="24" cy="24" r="24" fill="#25D366" />
      <path fill="#fff" d="M24.1 10.5a13.3 13.3 0 0 0-11.4 20.1l-1.9 6.9 7.1-1.9A13.3 13.3 0 1 0 24.1 10.5Zm0 2.4a10.9 10.9 0 1 1-5.6 20.3l-.5-.3-4.2 1.1 1.1-4.1-.3-.5A10.9 10.9 0 0 1 24.1 12.9Z" />
      <path fill="#fff" d="M19.2 17.8c-.3-.7-.6-.7-.9-.7h-.7c-.3 0-.7.1-1.1.5-.4.4-1.400 1.400-1.400 3.400s1.500 3.900 1.700 4.200c.2.300 2.900 4.600 7.100 6.200 3.500 1.400 4.200 1.100 4.900 1 .8-.1 2.500-1 2.800-2 .4-1 .4-1.800.2-2-.1-.2-.4-.3-.8-.5l-2.700-1.300c-.4-.1-.6-.2-.9.200l-1.200 1.500c-.2.300-.5.300-.9.100-.4-.2-1.700-.6-3.200-2-1.200-1.100-2-2.400-2.200-2.800-.2-.4 0-.6.200-.8l.6-.7c.2-.2.300-.4.400-.7.100-.3.100-.5 0-.7l-1.200-3Z" />
    </svg>
  );
}

export function InstagramLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Instagram">
      <defs><linearGradient id="ig-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#FEDA75" /><stop offset=".35" stopColor="#FA7E1E" /><stop offset=".6" stopColor="#D62976" /><stop offset="1" stopColor="#4F5BD5" /></linearGradient></defs>
      <rect width="48" height="48" rx="13" fill="url(#ig-g)" />
      <rect x="12" y="12" width="24" height="24" rx="7" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="24" cy="24" r="5.6" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="31.2" cy="16.8" r="1.7" fill="#fff" />
    </svg>
  );
}

export function MessengerLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Facebook Messenger">
      <defs><linearGradient id="ms-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#0099FF" /><stop offset="1" stopColor="#A033FF" /></linearGradient></defs>
      <circle cx="24" cy="24" r="24" fill="url(#ms-g)" />
      <path fill="#fff" d="M24 10.5c-7.5 0-13.2 5.5-13.2 12.9 0 3.9 1.600 7.200 4.200 9.500v4.600l4.300-2.400c1.500.4 3 .6 4.700.6 7.500 0 13.200-5.500 13.200-12.900S31.500 10.500 24 10.500Zm1.300 17.300-3.400-3.600-6.600 3.600 7.300-7.700 3.500 3.600 6.500-3.600-7.300 7.700Z" />
    </svg>
  );
}

export function ShopifyLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Shopify">
      <path fill="#95BF47" d="M33.300 11.200c0-.1-.1-.2-.2-.2l-2.300-.2s-1.500-1.500-1.700-1.700c-.2-.2-.5-.1-.6-.1l-.9.300c-.5-1.500-1.400-2.800-3-2.800h-.1c-.4-.6-1-.8-1.500-.8-3.600 0-5.300 4.500-5.800 6.800l-2.500.8c-.8.200-.8.300-.9 1L11.300 38l17.800 3.300 9.600-2.100s-5.300-27.900-5.400-28Z" />
      <path fill="#5E8E3E" d="m33.100 11-2.300-.2s-1.500-1.500-1.700-1.700c-.1-.1-.2-.1-.3-.1V41.300l9.600-2.100S33.200 11.200 33.100 11Z" />
      <path fill="#fff" d="m24.700 18.600-1.100 3.300s-1-.5-2.200-.4c-1.800.1-1.800 1.200-1.800 1.500.1 1.500 4 1.900 4.300 5.500.3 2.800-1.500 4.700-3.900 4.900-2.900.2-4.500-1.500-4.500-1.500l.6-2.600s1.600 1.200 2.900 1.100c.8-.1 1.100-.8 1.100-1.300-.2-2-3.300-1.900-3.500-5.200-.3-2.800 1.600-5.500 5.700-5.800 1.600-.1 2.400.5 2.400.5Z" />
    </svg>
  );
}

export function WooCommerceLogo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="WooCommerce">
      <rect x="2" y="8" width="44" height="26" rx="7" fill="#7F54B3" />
      <path fill="#7F54B3" d="M16 34h8l-8 7z" />
      <path fill="#fff" d="M8.500 15.500c.4-.5 1-.8 1.700-.8.900-.1 1.500.3 1.600 1.200.6 4 1.200 7.200 1.800 9.700l3.700-7c.3-.7.800-1 1.400-1.100.9-.1 1.400.3 1.700 1.300.4 1.600.9 3.800 1.500 5.400.4-3.200 1-5.500 1.600-6.900.2-.5.500-.8 1.100-.8.500 0 1 .1 1.300.4.400.3.500.7.400 1.200-.5 1.500-1.200 3.900-1.800 7.200-.5 2.600-1 4-1.900 4.100-.8.100-1.400-.6-2-2-.5-1.100-1.100-3-1.800-5.600-.9 1.800-1.900 3.600-2.800 5.400-1.100 2.200-2.100 3.200-3 3.300-.6 0-1.100-.5-1.500-1.600-.7-2.400-1.600-6.100-2.600-11.100-.1-.4 0-.9.300-1.200Zm28.300 1.700c.9.100 1.600.5 2 1.300.5.800.6 1.900.4 3.200-.4 2.700-1.600 4.300-3.300 4.800-.6.200-1.200.2-1.700.1-.9-.1-1.600-.5-2-1.300-.4-.7-.6-1.700-.4-3.100.4-2.100 1.200-3.600 2.600-4.500.7-.4 1.500-.6 2.400-.5Zm-.1 2c-.9 0-1.600.7-2.100 2-.2.600-.3 1.200-.3 1.700s.1 1 .3 1.300c.3.400.6.600 1 .6.600 0 1.100-.5 1.500-1.400.3-.7.400-1.400.4-2s-.1-1.200-.4-1.600c-.1-.4-.3-.6-.4-.6Z" />
    </svg>
  );
}


// ======== Roadmap rows ========

const slotText = (g, tz) => `${formatTimeInTz(g.start, tz)} – ${formatTimeInTz(g.end, tz)}`;
const free = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'} free` : `${formatMinutes(m)} free`);
const STATUS_CLASS = { overdue: 'is-overdue', onTrack: 'is-ontrack', upcoming: 'is-upcoming' };

export function TaskRow({ row, tz, next, onWhatIf }) {
  const partial = row.minutes < row.prep;
  return (
    <li className={`rm-row rm-task${next ? ' is-next' : ''}${row.section === 'overdue' ? ' is-late' : ''}`}>
      <time className="rm-time">{formatTimeInTz(row.start, tz)}<small>{formatTimeInTz(row.end, tz)}</small></time>
      <span className="rm-node" aria-hidden="true" />
      <article className="rm-card">
        {next && <p className="rm-next">Next up</p>}
        <header className="rm-card-head">
          <div>
            <h3>{row.customerName}</h3>
            <p className="rm-what">{row.item}<span> × {row.quantity}</span></p>
          </div>
          <em className={`rm-status ${STATUS_CLASS[row.section]}`}>{row.label}</em>
        </header>
        <dl className="rm-facts">
          <div><dt>Make</dt><dd>{formatTimeInTz(row.start, tz)} → {formatTimeInTz(row.end, tz)}</dd></div>
          <div><dt>Prep</dt><dd>{formatMinutes(row.prep)}{partial && <small> · {formatMinutes(row.minutes)} today</small>}</dd></div>
          <div><dt>Deliver by</dt><dd>{row.deadline ? formatInTz(row.deadline, tz) : '—'}</dd></div>
        </dl>
        {row.section !== 'onTrack' && row.reason && <p className="rm-reason">{row.reason}</p>}
        <footer className="rm-card-foot">
          <Link to={`/orders?edit=${row.id}`}>Open order</Link>
          <button type="button" onClick={() => onWhatIf(row)}>Test a different deadline <ArrowRight size={12} aria-hidden="true" /></button>
        </footer>
      </article>
    </li>
  );
}

export function GapRow({ gap, tz, skipped, onRush, onSkip, onRestore }) {
  if (skipped) {
    return (
      <li className="rm-row rm-gap is-skipped">
        <time className="rm-time">{formatTimeInTz(gap.start, tz)}</time>
        <span className="rm-node" aria-hidden="true" />
        <div className="rm-skip"><span>Skipped · {formatMinutes(gap.minutes)} kept clear</span><button type="button" onClick={onRestore}><RotateCcw size={12} aria-hidden="true" /> Restore</button></div>
      </li>
    );
  }
  return (
    <li className="rm-row rm-gap">
      <time className="rm-time">{formatTimeInTz(gap.start, tz)}<small>{formatTimeInTz(gap.end, tz)}</small></time>
      <span className="rm-node" aria-hidden="true" />
      <section className="rm-free" aria-label="Available capacity">
        <p className="rm-free-tag">Available capacity</p>
        <h3>{slotText(gap, tz)} <span>· {free(gap.minutes)}</span></h3>
        <p className="rm-free-note">{gap.canRush ? 'Room for a rush order.' : 'Too short for another order.'}</p>
        {gap.canRush && (
          <div className="rm-free-actions">
            <button type="button" className="btn btn-primary" onClick={onRush}><Plus size={15} aria-hidden="true" /> Add rush order</button>
            <button type="button" className="btn" onClick={onSkip}>Skip this slot</button>
          </div>
        )}
      </section>
    </li>
  );
}

const Fld = ({ label, error, hint, wide, children }) => (
  <label className={`field${error ? ' has-error' : ''}${wide ? ' rm-wide' : ''}`}>
    <span className="field-label">{label}</span>{children}
    {error ? <span className="field-note error" role="alert">{error}</span> : hint && <span className="field-hint">{hint}</span>}
  </label>
);

// "Add rush order": the order is run through the real scheduler (the What-if simulation) before anything is saved.
export function RushModal({ gap, tz, orders, onClose, onAccepted }) {
  const [f, setF] = useState({ customerName: '', item: '', quantity: '1', prep: String(Math.min(gap.minutes, 60)), deadline: toLocalInput(gap.end) });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(null);
  const [res, setRes] = useState(null);
  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setRes(null); setFail(null); };

  const payload = () => ({ customerName: f.customerName.trim(), item: f.item.trim(), quantity: Number(f.quantity), prepTimeMinutes: f.prep === '' ? null : Number(f.prep), deadline: fromLocalInput(f.deadline), source: 'manual' });
  function validate() {
    const o = payload(); const e = {};
    for (const d of validateOrder(o)) e[d.field] = d.message;
    if (o.prepTimeMinutes === null || !(o.prepTimeMinutes >= 5)) e.prepTimeMinutes = 'Enter the preparation time in minutes (at least 5).';
    else if (o.prepTimeMinutes > gap.minutes) e.prepTimeMinutes = `This slot only has ${formatMinutes(gap.minutes)} free.`;
    if (!o.deadline) e.deadline = 'A delivery deadline is needed to check the fit.';
    else if (Date.parse(o.deadline) < Date.parse(gap.start) + (o.prepTimeMinutes ?? 0) * 60000) e.deadline = 'The deadline is before this job could finish.';
    setErrors(e);
    return Object.keys(e).length === 0 ? o : null;
  }
  async function check(ev) {
    ev.preventDefault();
    const o = validate(); if (!o) return;
    setBusy(true); setFail(null);
    try { setRes(rushImpact(await simulatePlanner({ days: 30, probeMinutes: 15, changes: [{ type: 'add_order', order: o }] }), orders)); }
    catch (err) { setFail(err.message); } finally { setBusy(false); }
  }
  async function accept() {
    const o = validate(); if (!o) return;
    setBusy(true); setFail(null);
    try { await createOrder(o); onAccepted(o); }
    catch (err) { setFail(err.message); setBusy(false); }
  }
  return (
    <Modal title="Add rush order" onClose={onClose}>
      <p className="rm-modal-slot">{slotText(gap, tz)} · {free(gap.minutes)}</p>
      <form onSubmit={check} noValidate>
        <div className="form-grid">
          <Fld label="Customer *" error={errors.customerName}><input value={f.customerName} onChange={set('customerName')} /></Fld>
          <Fld label="Product *" error={errors.item}><input value={f.item} onChange={set('item')} /></Fld>
          <Fld label="Quantity" error={errors.quantity}><input type="number" min="1" step="1" value={f.quantity} onChange={set('quantity')} /></Fld>
          <Fld label="Preparation time (minutes) *" error={errors.prepTimeMinutes}><input type="number" min="5" max={gap.minutes} step="5" value={f.prep} onChange={set('prep')} /></Fld>
          <Fld label="Delivery deadline *" error={errors.deadline} hint="Later than your other deadlines keeps their order. An earlier one can move them." wide><input type="datetime-local" value={f.deadline} onChange={set('deadline')} /></Fld>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy && !res ? 'Checking…' : 'Check the fit'}</button>
        </div>
      </form>
      {fail && <div className="notice error" role="alert">{fail}</div>}
      {res && <RushResult res={res} tz={tz} busy={busy} onAccept={accept} />}
    </Modal>
  );
}

function RushResult({ res, tz, busy, onAccept }) {
  const { mine, moved, hurt, fits, tight } = res;
  return (
    <div className={`rm-result ${fits ? 'is-fit' : 'is-nofit'}`} role="status">
      <h3>{fits ? 'It fits without making anyone late.' : 'It does not fit safely.'}</h3>
      {mine?.scheduledEnd && <p className="rm-result-line"><Clock size={14} aria-hidden="true" /> Made {formatInTz(mine.scheduledStart, tz)} → {formatInTz(mine.scheduledEnd, tz)}{tight && ' · tight against its deadline'}</p>}
      {!mine?.scheduledEnd && <p className="rm-result-line">{mine?.reason ?? 'It cannot be scheduled.'}</p>}
      {hurt.length > 0 && (
        <ul className="rm-impact">{hurt.map((h) => <li key={h.orderId}><b>{h.name}</b> would become {h.risk === 'high' ? 'late' : 'tight'}. {h.reason}</li>)}</ul>
      )}
      {moved.length > 0 && hurt.length === 0 && (
        <>
          <p className="rm-result-line">{moved.length} existing {moved.length === 1 ? 'order moves' : 'orders move'} later, still on time:</p>
          <ul className="rm-impact">{moved.map((m) => <li key={m.id}><b>{m.name}</b> now finishes {formatInTz(m.now, tz)} ({m.delta > 0 ? '+' : '−'}{formatMinutes(Math.abs(m.delta))})</li>)}</ul>
        </>
      )}
      {moved.length === 0 && hurt.length === 0 && mine?.scheduledEnd && <p className="rm-result-line">No existing order changes.</p>}
      {fits && <div className="form-actions"><button type="button" className="btn btn-primary" onClick={onAccept} disabled={busy}>{busy ? 'Adding…' : 'Accept rush order'}</button></div>}
      {!fits && <p className="rm-result-line">Try a shorter job or a later deadline.</p>}
    </div>
  );
}

// ======== What-if ========

// Smart Commitment Management: one simulation, Move a deadline. Every verdict, earliest realistic deadline and before/after count comes from the shared
// workload engine (GET /planner/whatif, POST /planner/whatif/move) run on copies of the real orders; this file only draws it. Nothing is saved while
// simulating; the owner applies a change explicitly (PATCH /orders/:id), which is what the Plan then reflects. Framer Motion draws the cards and arrows.
const dayText = (iso, tz) => new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
const dayKey = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso));
// "9:30 AM", or "Tue 11:30 AM" when it is not the day of the reference time
const clock = (iso, tz, ref) => {
  const t = formatTimeInTz(iso, tz);
  return ref && dayKey(iso, tz) !== dayKey(ref, tz) ? `${new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short' }).format(new Date(iso))} ${t}` : t;
};
const wall = (iso, tz) => { const p = zonedParts(new Date(iso), tz); const z = (n) => String(n).padStart(2, '0'); return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`; }; // for <input type="datetime-local">, in the BUSINESS timezone
const unwall = (v, tz) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v); return m ? zonedTimeToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, tz).toISOString() : null; };

// The production sequence: one large card per order with an animated arrow to the next (a row on a wide screen, a column on a phone). Card tone:
// 'idle' (pastel blue), 'shared' (blue with a caramel edge: it shares its deadline with another order), 'moved' (caramel: the order being tested)
// or 'clash' (soft red: a missed deadline). The cards and arrows enter in turn (Framer Motion); when a simulation changes the sequence the cards glide
// to their new places and the arrows draw themselves again. 
const stageV = { hidden: {}, show: { transition: { staggerChildren: 0.12, delayChildren: 0.05 } } };
const cardV = { hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 0.61, 0.36, 1] } } };
function Arrow({ tone }) {
  return (
    <motion.div className={`wxc-link is-${tone}`} aria-hidden="true" variants={{ hidden: { opacity: 0 }, show: { opacity: 1 } }}>
      <svg viewBox="0 0 64 20" focusable="false">
        <motion.path d="M2 10 H56" fill="none" variants={{ hidden: { pathLength: 0 }, show: { pathLength: 1, transition: { duration: 0.6, ease: 'easeOut' } } }} />
        <motion.path d="M50 4 L58 10 L50 16" fill="none" variants={{ hidden: { opacity: 0 }, show: { opacity: 1, transition: { delay: 0.45, duration: 0.2 } } }} />
      </svg>
    </motion.div>
  );
}
function FlowStage({ cards, landed = Infinity }) {
  const sig = cards.map((c) => c.id).join('|'); // a different sequence replays the entrance, so the new order is read left to right again
  return (
    <div className="wxc-scroll">
      <motion.ol className="wxc-stage" key={sig} variants={stageV} initial="hidden" animate="show" aria-label="Proposed production sequence">
        {cards.map((c, i) => (
          <li className={`wxc-cell${i >= landed ? ' is-undealt' : ''}`} key={c.id}>
            {i > 0 && <Arrow tone={c.tone === 'clash' ? 'clash' : c.tone === 'moved' ? 'moved' : 'idle'} />}
            <motion.article variants={cardV} whileHover={{ y: -3 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}
              className={`wxc-card is-${c.tone}`}>
              <span className="wxc-step" aria-hidden="true">{i + 1}</span>
              <h3>{c.name}</h3><p className="wxc-item">{c.item}</p>
              <p className="wxc-prep">Preparation {c.prep}</p>
              <b className="wxc-time" key={c.range}>{c.range}</b>
              <p className="wxc-due">{c.due}</p>
              <p className={`wxc-status is-${c.status.kind}`}>{c.status.text}</p>
              {c.tag && <span className="wxc-tag">{c.tag}</span>}
            </motion.article>
          </li>
        ))}
      </motion.ol>
    </div>
  );
}


const stamp = (iso, tz) => `${new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso))}, ${formatTimeInTz(iso, tz)}`;
// Where an order stands against its CURRENT deadline, in the owner's words. `rank` puts the ones needing attention first.
const standing = (c) => (c.kind === 'deadline_passed' ? { key: 'overdue', label: 'Deadline passed', rank: 0 } : c.risk === 'high' ? { key: 'late', label: 'Cannot meet deadline', rank: 1 } : c.risk === 'medium' ? { key: 'tight', label: 'Tight', rank: 2 } : { key: 'ok', label: 'On track', rank: 3 });

export function WhatIfPage({ scope }) {
  const q = useAsync(() => getWhatIf(scope), [scope]);
  const d = q.data;
  if (q.status === 'error') return <StateMessage kind="error" message={`Couldn't load the schedule. ${q.error.message}`} onRetry={q.reload} />;
  if (!d) return <StateMessage kind="loading" message="Running the scheduler…" />;
  return (
    <>
      <section className="wx" aria-label="What if">
        <header className="wx-head"><h1>What <em>if?</em></h1><p>Conversa doesn't just accept orders. It understands whether you can keep your promises.</p></header>
        {d.cards.length === 0 ? <StateMessage message="There are no open orders with a deadline and a preparation time to check yet." />
          : <Commitment d={d} scope={scope} onApplied={q.reload} />}
        {(d.awaiting ?? []).length > 0 && <p className="wx-none" role="status">{d.awaiting.map((a) => a.customerName).join(', ')} {d.awaiting.length === 1 ? 'sent a request' : 'sent requests'} through chat that {d.awaiting.length === 1 ? 'is' : 'are'} still a draft, so {d.awaiting.length === 1 ? 'it is' : 'they are'} not in this schedule yet. <Link to={`/orders?edit=${d.awaiting[0].id}`}>Review {d.awaiting.length === 1 ? 'it' : 'the first'}</Link> and confirm to include {d.awaiting.length === 1 ? 'it' : 'them'}.</p>}
        {d.needsDetails.length > 0 && <p className="wx-none" role="status">{d.needsDetails.length} {d.needsDetails.length === 1 ? 'order has' : 'orders have'} no deadline or preparation time and {d.needsDetails.length === 1 ? 'is' : 'are'} not included.</p>}
      </section>
    </>
  );
}

const prepText = (m) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

// Orders promised the same time, in the order the requests are listed (by customer, never by preparation time), taken from the schedule the engine returned.
const conflictGroup = (cards) => {
  const by = {};
  for (const c of cards) (by[c.deadline] ??= []).push(c);
  const g = Object.values(by).filter((x) => x.length > 1).sort((x, y) => Date.parse(x[0].deadline) - Date.parse(y[0].deadline))[0];
  return g ? [...g].sort((x, y) => x.customerName.localeCompare(y.customerName)) : null;
};

// The headline of the page: which orders were promised the same time and what each needs. Once the simulation has run it also says whether one baker can
// keep both promises, read from the scheduler's result; nothing is decided here.
function ConflictBrief({ cards, after, tz, T }) {
  const group = conflictGroup(cards);
  if (!group) return null;
  const when = clock(group[0].deadline, tz);
  const names = group.map((c) => c.customerName);
  let result = null;
  if (after) {
    const seq = after.filter((c) => group.some((g) => g.id === c.id)).sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    const miss = seq.filter((c) => !c.end || Date.parse(c.end) > Date.parse(c.deadline));
    const others = after.filter((c) => !group.some((g) => g.id === c.id));
    const hurt = others.filter((c) => c.risk === 'high');
    const total = seq.reduce((n, c) => n + c.prepTimeMinutes, 0);
    result = (
      <p className={`wxb-result${miss.length ? ' is-bad' : ''}`}><b>{miss.length === 0 ? 'Both can be delivered on time.' : 'Not feasible.'}</b>{' '}
        {miss.length === 0 ? `${total} minutes of work fit before ${when}: ${seq.map((c) => `${c.customerName} ${clock(c.start, tz)}–${clock(c.end, tz)}`).join(', then ')}.`
          : `Together they need ${total} minutes of preparation and ${miss[0].customerName} would finish ${miss[0].end ? clock(miss[0].end, tz) : 'too late'}.${miss[0].earliest ? ` The earliest realistic delivery is ${T(miss[0].earliest.deadline)}.` : ''}`}{' '}
        {hurt.length === 0 ? `${others.length} other ${others.length === 1 ? 'customer is' : 'customers are'} not affected.` : `${hurt.map((c) => c.customerName).join(', ')} would also be late.`}</p>
    );
  }
  return (
    <motion.section className={`wxb${after ? ' is-done' : ''}`} aria-label="Conflicting requests" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}>
      <p className="wxb-kicker">Two customers, one time</p>
      <h2>{names.join(' and ')} both want delivery at {when}</h2>
      <ul className="wxb-pair">{group.map((c) => <li key={c.id}><b>{c.customerName}</b><span>{c.item}</span><i>{prepText(c.prepTimeMinutes)} to prepare</i><em>Requested delivery: {T(c.deadline)}</em></li>)}</ul>
      {result ?? <p className="wxb-result">One baker, one deadline. Can both promises be kept, and who should be prepared first?</p>}
    </motion.section>
  );
}

// What if? Run simulation asks the scheduler (through the same Move a deadline simulation, with the deadline left as it is) for the production sequence of
// the real orders. Nothing is saved: the simulation runs on copies.
function Commitment({ d, scope, onApplied }) {
  const navigate = useNavigate();
  const [applying, setApplying] = useState(false); const [applyErr, setApplyErr] = useState(null); const [justApplied, setJustApplied] = useState(false);
  const tz = d.timezone; const T = (iso) => stamp(iso, tz);
  const pitch = scope === 'commitment'; // the prepared two-customers-one-time scenario; otherwise the owner picks any open order and a new delivery time
  const group = conflictGroup(d.cards);
  const [pickId, setPickId] = useState(() => (group?.[0] ?? d.cards.find((c) => Date.parse(c.deadline) > Date.now()) ?? d.cards[0]).id); // not one whose deadline has already passed
  const picked = d.cards.find((c) => c.id === pickId) ?? d.cards[0];
  const [when, setWhen] = useState(() => isoToLocalInput(picked.deadline, d.timezone));
  const target = pitch ? (group?.[0] ?? d.cards[0]) : { ...picked, deadline: localInputToIso(when, d.timezone) ?? picked.deadline };
  const choose = (id) => { setPickId(id); setWhen(isoToLocalInput(d.cards.find((c) => c.id === id)?.deadline, d.timezone)); setRes(null); setLanded(Infinity); };
  const [res, setRes] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  // The deck animation plays once per calculated result (and when the owner asks for it again): `play` counts the plays, `landed` is how many order cards have been
  // dealt so far (Infinity = all of them, i.e. nothing is being animated). The cards and their data are the scheduler's result either way.
  const [play, setPlay] = useState(0); const [landed, setLanded] = useState(Infinity);
  const deal = () => { setLanded(0); setPlay((n) => n + 1); };
  const run = async () => {
    setBusy(true); setErr(null);
    try { const r = await simulateMove(scope, { orderId: target.id, deadline: target.deadline }); setRes(r); if (r?.ok) deal(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const ok = res?.ok ? res : null;
  const applied = d.applied || justApplied; // this scenario is already the Plan (persisted), or was applied a moment ago
  // The owner's approval: the only thing on this page that changes anything. Simulating never does.
  const apply = async () => {
    setApplying(true); setApplyErr(null);
    try { await applyWhatIf(scope); setJustApplied(true); onApplied?.(); } catch (e) { setApplyErr(e.message); } finally { setApplying(false); }
  };
  const after = ok?.after.cards ?? null;
  const inGroup = (c) => (pitch ? group?.some((g) => g.id === c.id) : c.id === picked.id); // the order(s) being moved; everyone else is who it may affect
  const others = after ? after.filter((c) => !inGroup(c)) : [];
  const lateNow = after ? after.filter((c) => !c.end || Date.parse(c.end) > Date.parse(c.deadline)) : [];
  const withEarliest = lateNow.map((c) => d.cards.find((x) => x.id === c.id)).find((c) => c?.earliest);

  const cards = (after ?? []).map((c) => {
    const missed = !c.end || Date.parse(c.end) > Date.parse(c.deadline);
    const sharing = after.filter((x) => x.deadline === c.deadline).length > 1;
    const status = !c.end ? { kind: 'bad', text: 'Not schedulable' }
      : missed ? { kind: 'bad', text: `${c.shortfallMinutes ? formatMinutes(c.shortfallMinutes) : 'Some time'} too late` }
        : { kind: 'ok', text: c.bufferMinutes > 0 ? `On time · ${formatMinutes(c.bufferMinutes)} to spare` : 'On time · finishes at the deadline' };
    return { id: c.id, name: c.customerName, item: c.item, prep: prepText(c.prepTimeMinutes), tone: missed ? 'clash' : sharing ? 'shared' : 'idle', due: <>Due {clock(c.deadline, tz, c.start)}</>, status,
      range: c.end ? `${clock(c.start, tz, c.deadline)} – ${clock(c.end, tz, c.start)}` : 'Not schedulable',
      tag: sharing ? `Shares the ${clock(c.deadline, tz)} deadline` : null };
  });

  return (
    <>
      {pitch ? <ConflictBrief cards={d.cards} after={after} tz={tz} T={T} /> : (
        <section className="wxm" aria-label="Move a deadline">
          <p className="wxb-kicker">Smart commitment management</p>
          <h2>Move a deadline and see who it affects</h2>
          <div className="wxm-form">
            <label><span>Order</span><select value={picked.id} onChange={(e) => choose(e.target.value)}>{d.cards.map((c) => <option key={c.id} value={c.id}>{c.customerName} · {c.item}</option>)}</select></label>
            <label><span>New delivery time ({tz})</span><input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setRes(null); setLanded(Infinity); }} /></label>
          </div>
          <p className="wxm-note">Currently due {T(picked.deadline)}, takes {prepText(picked.prepTimeMinutes)}. The whole schedule is re-planned on copies; nothing is saved.</p>
        </section>
      )}
      <div className="wx-run">
        <button type="button" className="btn btn-primary btn-run" onClick={run} disabled={busy || Boolean(ok)}>{busy ? 'Simulating…' : ok ? 'Simulation complete' : <>Run simulation <ArrowRight size={16} aria-hidden="true" /></>}</button>
        {ok && <button type="button" className="btn" onClick={() => { setRes(null); setLanded(Infinity); }}>Start over</button>}
        {ok && <button type="button" className="btn wx-replay" onClick={deal} disabled={landed < cards.length}>Replay animation</button>}
      </div>
      {pitch && applied && !ok && <p className="wx-applied" role="status"><b>This commitment is applied to your Plan.</b> <button type="button" className="wx-link" onClick={() => navigate('/plan')}>Open Plan →</button></p>}
      {res && !res.ok && <p className="wx-none" role="alert">{res.message}</p>}
      {err && <p className="wx-none" role="alert">{err}</p>}
      <AnimatePresence>
        {ok && (
          <motion.div className="wx-result" key="result" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.6, ease: [0.22, 0.61, 0.36, 1] }}>
            <h2 className="wx-h">Proposed production sequence</h2>
            <DeckStage play={play} count={cards.length} onLanded={setLanded}><FlowStage cards={cards} landed={landed} /></DeckStage>
            <div className="wxs-answers">
              <article className={`wxs-ans is-${lateNow.length === 0 ? 'ok' : 'bad'}`}><h3>Can I fulfil these orders on time?</h3><b>{lateNow.length === 0 ? 'Yes' : 'No'}</b>
                <p>{lateNow.length === 0 ? 'Every order finishes by its deadline.' : `${lateNow.map((c) => c.customerName).join(', ')} would miss ${lateNow.length === 1 ? 'its' : 'their'} deadline.`}</p></article>
              <article className={`wxs-ans is-${others.some((c) => c.risk === 'high') ? 'bad' : 'ok'}`}><h3>Are other customers affected?</h3><b>{others.some((c) => c.risk === 'high') ? 'Yes' : 'No'}</b>
                <p>{others.some((c) => c.risk === 'high') ? `${others.filter((c) => c.risk === 'high').map((c) => c.customerName).join(', ')} would be late.` : `${others.map((c) => c.customerName).join(', ')} stay on schedule.`}</p></article>
              <article className={`wxs-ans is-${withEarliest ? 'warn' : 'ok'}`}><h3>Earliest realistic delivery</h3>
                {withEarliest ? <><b>{T(withEarliest.earliest.deadline)}</b><p>For {withEarliest.customerName}, from the actual production schedule.</p></> : <><b>No change needed</b><p>Every requested delivery time can be kept.</p></>}</article>
              <article className={`wxs-ans is-${ok.after.feasible ? 'ok' : 'bad'}`}><h3>Is the schedule feasible?</h3><b>{ok.after.feasible ? 'Yes' : 'No'}</b><p>{ok.after.feasible ? (applied ? 'Applied: this is now your production plan.' : 'Nothing was changed: this is a proposal, not your saved plan.') : `${ok.after.conflicts} ${ok.after.conflicts === 1 ? 'order still misses' : 'orders still miss'} its deadline.`}</p></article>
            </div>
            {pitch && ok.after.feasible && (
              <div className={`wx-apply${applied ? ' is-done' : ''}`}>
                {applied ? <><p><b>Applied to your Plan.</b> The Plan now follows this sequence, and the delivery times above are your orders' deadlines.</p><button type="button" className="btn btn-primary" onClick={() => navigate('/plan')}>Open Plan <ArrowRight size={16} aria-hidden="true" /></button></>
                  : <><p><b>Make this your plan?</b> This is only a proposal. Apply to Plan sets these delivery times on the orders and makes this sequence your production plan. Nothing else about the orders changes.</p>
                    <button type="button" className="btn btn-primary" onClick={apply} disabled={applying}>{applying ? 'Applying…' : 'Apply to Plan'}</button></>}
                {applyErr && <p className="wx-none" role="alert">{applyErr}</p>}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
