import { Link } from 'react-router-dom';
import { ArrowRight, Check, ChevronDown, FlaskConical, Pencil, Info, PenLine, CalendarClock, Timer, Zap } from 'lucide-react';
import useAsync from '../hooks/useAsync.js';
import { getConversations, simulatePlanner, createOrder, updateOrder } from '../services/api.js';
import { summarise } from '../utils/homeSummary.js';
import { formatDayInTz, formatInTz, formatMinutes, formatTimeInTz, isDemoOrder, STATUS_LABEL, formatLongInTz, toLocalInput, fromLocalInput, OPEN } from '../utils/format.js';
import { useId, useState, useEffect, useMemo } from 'react';
import { findExperiments } from '../utils/experiments.js';
import { buildComparison } from '../utils/scheduleDiff.js';
import { SectionHead } from './Layout.jsx';
import { RiskBadge, DemoBadge, Modal, StateMessage } from './UI.jsx';
import { CountUp } from './Effects.jsx';
import '../css/Workspace.css';
import '../css/Risk.css';

// ---------- DayWorkspace ----------
const plural = (n, one, many) => (n === 1 ? one : many);
const MISSING = { missing_prep_time: 'preparation time', missing_deadline: 'deadline', missing_both: 'preparation time and deadline' };
const MAX_ISSUES = 3;
const MAX_UPCOMING = 3;

// Under the hero: how busy am I, what needs attention, what should I do next. Everything is derived from the planner and orders
// the API already returns (see utils/homeSummary.js); the scheduler's own ranking decides what comes first.
export function DayWorkspace({ planner, orders }) {
  const conv = useAsync(getConversations); // optional: only to link an order to its chat
  const { tz, today, byId, open, todayIds, issues, missingIds, riskIds, attention, nextDeadline, top } = summarise({ planner, orders });
  const entry = Object.fromEntries(planner.schedule.map((e) => [e.orderId, e]));
  const chatOf = Object.fromEntries((conv.data?.items ?? []).filter((c) => c.orderId).map((c) => [c.orderId, c.id]));
  const unscheduledReason = Object.fromEntries(planner.unscheduledOrders.map((u) => [u.id, u.reason]));

  if (orders.length === 0) return <StateMessage message="No orders yet. Add your first order, or draft one from a customer message."><Link className="btn btn-primary" to="/orders">Go to Orders</Link></StateMessage>;

  const attentionTo = riskIds.size > 0 ? '/plan?focus=risk' : '/plan?focus=missing';
  const metrics = [
    { key: 'today', label: 'Orders today', value: todayIds.size, note: 'due or scheduled today', to: '/plan' },
    { key: 'attn', label: 'Need attention', value: attention, note: attention ? `${riskIds.size} at risk · ${missingIds.size} missing details` : 'nothing urgent', to: attention ? attentionTo : '/plan', tone: attention ? 'risk' : null },
    { key: 'next', label: 'Next deadline', value: nextDeadline ? formatInTz(nextDeadline.deadline, tz) : 'None upcoming', note: nextDeadline ? `${nextDeadline.customerName} · ${nextDeadline.item}` : 'no open order has a future deadline', to: nextDeadline ? `/orders?edit=${nextDeadline.id}` : '/orders', small: true },
  ];

  const issueRows = issues.slice(0, MAX_ISSUES).map((m) => {
    const o = byId[m.orderId]; const e = entry[m.orderId];
    const missing = m.kind === 'needs_details';
    const reason = missing ? `Missing ${MISSING[unscheduledReason[m.orderId]] ?? 'details'}, so it can't be scheduled.`
      : m.kind === 'deadline_passed' ? `Deadline passed${o.deadline ? ` ${formatInTz(o.deadline, tz)}` : ''}.`
        : m.kind === 'tight' ? `Only ${formatMinutes(e?.bufferMinutes)} to spare before the deadline.`
          : m.kind === 'late' ? `Predicted to finish ${formatMinutes(e?.shortfallMinutes)} after the deadline.`
            : 'Cannot be scheduled in the planning window.';
    return { m, o, missing, reason, tone: missing ? 'info' : m.kind === 'tight' ? 'warn' : 'late' };
  });

  const nextStep = top ? (() => {
    const o = byId[top.orderId];
    const contact = (top.kind === 'deadline_passed' || top.kind === 'late') && chatOf[top.orderId];
    return { top, o, to: contact ? `/inbox?conversation=${chatOf[top.orderId]}` : `/orders?edit=${top.orderId}`, label: contact ? 'Open conversation' : top.kind === 'needs_details' ? 'Add details' : 'Review order' };
  })() : null;

  const first = new Map();
  for (const d of planner.days) for (const b of d.orders) if (byId[b.id] && !first.has(b.id)) first.set(b.id, { ...b, date: d.date });
  const upcoming = [...first.values()].filter((r) => !riskIds.has(r.id) || entry[r.id]?.kind !== 'deadline_passed').sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, MAX_UPCOMING);

  return (
    <div className="dw">
      <SectionHead eyebrow="Today" title="Your day at a glance." />
      <dl className="dw-metrics">
        {metrics.map((x) => (
          <Link key={x.key} to={x.to} className={`dw-metric${x.tone ? ` is-${x.tone}` : ''}`}>
            <dt>{x.label}</dt>
            <dd className={x.small ? 'is-small' : ''}>{x.value}</dd>
            <small>{x.note}</small>
          </Link>
        ))}
      </dl>

      <div className="dw-cols">
        <div className="dw-left">
          <section className="dw-sec" aria-labelledby="dw-attn">
            <div className="dw-sec-head"><span className="dw-step">1 · Now</span><h3 id="dw-attn">Needs your attention</h3>{attention > MAX_ISSUES && <Link to={attentionTo} className="dw-all">View all {attention} <ArrowRight size={14} aria-hidden="true" /></Link>}</div>
            {issueRows.length === 0 ? (
              <p className="dw-clear"><Check size={16} aria-hidden="true" /> You're all caught up. No order is overdue, at risk or missing details.</p>
            ) : (
              <ul className="dw-issues">
                {issueRows.map(({ m, o, missing, reason, tone }) => (
                  <li key={m.orderId} className={`dw-issue is-${tone}`}>
                    <span className="dw-bar" aria-hidden="true" />
                    <div className="dw-issue-main">
                      <p><strong>{o.customerName}</strong>{isDemoOrder(o) && <span className="demo-tag">Demo</span>}<span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></p>
                      <p className="dw-reason">{reason}{!missing && o.deadline && m.kind !== 'deadline_passed' && <> Due {formatInTz(o.deadline, tz)}.</>}</p>
                    </div>
                    <Link to={`/orders?edit=${o.id}`} className="dw-act">{missing ? 'Add details' : 'Review order'} <ArrowRight size={14} aria-hidden="true" /></Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="dw-sec dw-upcoming" aria-labelledby="dw-up">
            <div className="dw-sec-head"><span className="dw-step">2 · Next</span><h3 id="dw-up">Coming up</h3><Link to="/plan" className="dw-all">Full schedule <ArrowRight size={14} aria-hidden="true" /></Link></div>
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

        <section className="dw-sec dw-next" aria-labelledby="dw-next">
          <div className="dw-sec-head"><span className="dw-step">3 · Do this</span><h3 id="dw-next">Recommended next step</h3></div>
          {nextStep ? (
            <>
              <p className="dw-next-action">{nextStep.top.action}</p>
              <p className="dw-next-why">{nextStep.top.why}</p>
              <Link to={nextStep.to} className="btn btn-primary">{nextStep.label} <ArrowRight size={16} aria-hidden="true" /></Link>
            </>
          ) : <p className="dw-clear">Nothing is waiting on you right now.</p>}
        </section>
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
const CHANNELS = [
  { key: 'whatsapp', name: 'WhatsApp', Logo: WhatsAppLogo, purpose: 'Customer messages and order requests will arrive in your inbox, ready to turn into orders.' },
  { key: 'instagram', name: 'Instagram', Logo: InstagramLogo, purpose: 'Direct messages from your profile will land in the same inbox, next to every other conversation.' },
];

// Neither channel is wired up: the tiles are informational only (no buttons, no OAuth, no connected state).
export function ConnectSection() {
  return (
    <div className="cx">
      <h2 className="cx-lead">Bring your conversations together.</h2>
      <div className="cx-body">
        <div className="cx-intro">
          <p className="eyebrow">Channels</p>
          <h3 className="cx-title">Your conversations. <em>One workspace.</em></h3>
          <p className="cx-text">Connect the channels where your customers already reach you, or get started by adding orders manually.</p>
        </div>

        <ul className="cx-tiles">
          {CHANNELS.map(({ key, name, Logo, purpose }) => (
            <li key={key} className={`cx-tile cx-${key}`}>
              <Logo size={44} />
              <div>
                <p className="cx-name">{name} <span className="cx-status">Coming soon · Not connected</span></p>
                <p className="cx-purpose">{purpose}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="cx-paths">
        <p className="cx-paths-label">Conversa works today, without either channel.</p>
        <div className="cx-actions">
          <Link to="/plan" className="btn btn-primary">Continue with demo data <ArrowRight size={16} aria-hidden="true" /></Link>
          <Link to="/orders?edit=new" className="btn"><PenLine size={15} aria-hidden="true" /> Add an order manually</Link>
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

export function InstagramLogo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Instagram">
      <defs>
        <radialGradient id="ig-grad" cx="0.3" cy="1.05" r="1.25">
          <stop offset="0" stopColor="#FFD879" />
          <stop offset="0.25" stopColor="#F9A03A" />
          <stop offset="0.5" stopColor="#E1306C" />
          <stop offset="0.8" stopColor="#A133B8" />
          <stop offset="1" stopColor="#5851DB" />
        </radialGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#ig-grad)" />
      <rect x="12.5" y="12.5" width="23" height="23" rx="7" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="24" cy="24" r="5.6" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="30.8" cy="17.2" r="1.7" fill="#fff" />
    </svg>
  );
}

// ---------- WhatIfWorkspace ----------
const SCENARIOS = [
  { key: 'deadline', title: 'Fix a deadline', exp: 'deadline', Icon: CalendarClock },
  { key: 'prep', title: 'Reduce prep time', exp: 'prep', Icon: Timer },
  { key: 'rush', title: 'Add a rush order', exp: 'rush', Icon: Zap },
];
const EMPTY = { deadline: { orderId: '', deadline: '' }, prep: { orderId: '', prep: '' }, rush: { customerName: 'New customer', item: 'Rush order', prep: '60', deadline: '' } };

// The whole What-if experience on one screen: pick a scenario, run it, and watch every order's row show what would change.
// A run is POST /planner/simulate, which works on a copy on the server: nothing is saved until "Confirm changes" and an explicit second
// confirmation, which then uses the normal order endpoints.
export function WhatIfWorkspace({ planner, orders, onApplied, prefill }) {
  const tz = planner.range.timezone;
  const days = planner.range.days;
  const byId = useMemo(() => Object.fromEntries(orders.map((o) => [o.id, o])), [orders]);
  const openOrders = orders.filter((o) => OPEN.includes(o.status));
  const T = (iso) => (iso ? formatInTz(iso, tz) : '—');

  const [exps, setExps] = useState(null);       // the scheduler-checked proposal for each scenario (null while pre-checking)
  const [scen, setScen] = useState('deadline');
  const [drafts, setDrafts] = useState(EMPTY);
  const [sim, setSim] = useState(null);         // { change, result, key }
  const [view, setView] = useState('sim');      // 'orig' | 'sim'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(null);

  // Proposals come from the scheduler (see utils/experiments.js); they are only starting values, and every field stays editable.
  useEffect(() => {
    let live = true;
    setExps(null);
    findExperiments({ planner, orders, simulate: simulatePlanner, days })
      .then((list) => {
        if (!live) return;
        const m = Object.fromEntries(list.map((x) => [x.type, x]));
        setExps(m);
        setDrafts((d) => ({
          deadline: m.deadline?.change ? { orderId: m.deadline.change.orderId, deadline: toLocalInput(m.deadline.change.order.deadline) } : d.deadline,
          prep: m.prep?.change ? { orderId: m.prep.change.orderId, prep: String(m.prep.change.order.prepTimeMinutes) } : d.prep,
          rush: m.rush?.change ? { customerName: m.rush.change.order.customerName, item: m.rush.change.order.item, prep: String(m.rush.change.order.prepTimeMinutes), deadline: toLocalInput(m.rush.change.order.deadline) } : d.rush,
        }));
      })
      .catch(() => { if (live) setExps({}); });
    return () => { live = false; };
  }, [planner, orders, days]);

  // "Simulate" buttons on the Risks page arrive here with an order and a deadline to try. Nothing runs or saves.
  useEffect(() => {
    if (!prefill) return;
    setScen('deadline'); setSim(null); setError(null); setDone(null); setConfirming(false);
    setDrafts((d) => ({ ...d, deadline: { orderId: prefill.orderId, deadline: toLocalInput(prefill.deadline) } }));
  }, [prefill?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = drafts[scen];
  const setField = (k) => (e) => setDrafts((x) => ({ ...x, [scen]: { ...x[scen], [k]: e.target.value } }));
  const pickOrder = (e) => {
    const o = byId[e.target.value];
    setDrafts((x) => ({ ...x, [scen]: scen === 'deadline' ? { orderId: e.target.value, deadline: toLocalInput(o?.deadline) } : { orderId: e.target.value, prep: o?.prepTimeMinutes ?? '' } }));
  };

  const valid = scen === 'deadline' ? d.orderId && d.deadline
    : scen === 'prep' ? d.orderId && d.prep !== '' && Number(d.prep) >= 0
      : d.customerName.trim() && d.item.trim() && d.prep !== '' && Number(d.prep) > 0 && d.deadline;
  const buildChange = () => (scen === 'deadline' ? { type: 'update_order', orderId: d.orderId, order: { deadline: fromLocalInput(d.deadline) } }
    : scen === 'prep' ? { type: 'update_order', orderId: d.orderId, order: { prepTimeMinutes: Number(d.prep) } }
      : { type: 'add_order', order: { customerName: d.customerName.trim(), item: d.item.trim(), quantity: 1, prepTimeMinutes: Number(d.prep), deadline: fromLocalInput(d.deadline), source: 'manual' } });
  const key = JSON.stringify([scen, d]);

  async function run() {
    setBusy(true); setError(null); setConfirming(false); setDone(null);
    const change = buildChange();
    try { setSim({ change, key, result: await simulatePlanner({ changes: [change], days, probeMinutes: 60 }) }); setView('sim'); }
    catch (e) { setSim(null); setError(e); }
    finally { setBusy(false); }
  }
  function discard() { setSim(null); setError(null); setConfirming(false); setDone(null); setView('orig'); if (exps) setDrafts((x) => ({ ...x })); }
  async function apply() {
    setBusy(true); setError(null);
    try {
      if (sim.change.type === 'add_order') await createOrder(sim.change.order); else await updateOrder(sim.change.orderId, sim.change.order);
      setDone('Saved. The schedule below now reflects the change.'); setSim(null); setConfirming(false); setView('orig'); onApplied?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const baseline = planner;
  const cmp = useMemo(() => {
    if (!sim) return null;
    const base = sim.result.baseline ?? { schedule: baseline.schedule ?? [], unscheduledOrders: baseline.unscheduledOrders ?? [] };
    return buildComparison({ orders, baseline: base, after: sim.result.planner, change: sim.change, byId, tz });
  }, [sim, orders, byId, tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const stale = Boolean(sim && sim.key !== key);
  const showSim = Boolean(cmp) && view === 'sim';

  const rows = showSim ? cmp.rows : orders.map((o) => ({ id: o.id, name: o.customerName, item: o.item, quantity: o.quantity, orig: { deadline: o.deadline, prep: o.prepTimeMinutes, finish: planner.schedule?.find((e) => e.orderId === o.id)?.scheduledEnd ?? null, status: cmpStatus(o, planner) }, sim: null }));
  const exp = exps?.[SCENARIOS.find((s) => s.key === scen).exp];
  const cur = byId[d.orderId];
  const s = cmp?.summary;

  const subOf = (sc) => {
    const x = exps?.[sc.exp];
    if (!exps) return 'Checking…';
    if (sc.key === 'rush') return x?.change ? '1-hour job' : 'No free hour';
    const o = x?.change?.orderId ? byId[x.change.orderId] : null;
    if (!o) return 'No safe option';
    return sc.key === 'deadline' ? `${o.customerName} · ${cmpStatus(o, planner).label}` : o.customerName;
  };
  const unavailable = exp?.unavailable;
  const prepText = (v) => (v == null ? 'Not set' : formatMinutes(v));
  const metric = (before, after) => (after < before ? 'better' : after > before ? 'worse' : 'same');
  const metrics = cmp && [
    { label: 'Orders changed', value: `${s.changed} of ${s.total}`, tone: s.changed ? 'info' : 'same', word: s.changed ? 'Changed' : 'Unchanged' },
    { label: 'Deadlines at risk', value: `${s.beforeRisk} → ${s.afterRisk}`, tone: metric(s.beforeRisk, s.afterRisk), word: { better: 'Improved', worse: 'Worse', same: 'Unchanged' }[metric(s.beforeRisk, s.afterRisk)] },
    { label: 'Schedule feasibility', value: !s.passes ? 'Not feasible' : s.afterHigh === 0 ? 'Feasible' : `${s.afterHigh} still late`, tone: !s.passes ? 'worse' : s.afterHigh < s.beforeHigh ? 'better' : s.afterHigh > s.beforeHigh ? 'worse' : 'same', word: !s.passes ? 'Worse' : s.afterHigh < s.beforeHigh ? 'Improved' : s.afterHigh > s.beforeHigh ? 'Worse' : 'Unchanged' },
  ];

  return (
    <>
      <header className="wf-head">
        <div><p className="eyebrow">What-if simulator</p><h1>Change the plan.</h1><p className="wf-sub">See the impact before you commit.</p></div>
        <DemoBadge />
      </header>

      <section className="wf-setup" aria-label="Scenario">
        <div className="wf-pick" role="radiogroup" aria-label="Scenario">
          {SCENARIOS.map(({ key: k, title, Icon, ...sc }) => (
            <button key={k} type="button" role="radio" aria-checked={scen === k} className={`wf-opt${scen === k ? ' is-on' : ''}`} onClick={() => { setScen(k); setSim(null); setError(null); setConfirming(false); setView('orig'); }}>
              <Icon size={18} aria-hidden="true" /><span><strong>{title}</strong><small>{subOf({ key: k, title, ...sc })}</small></span>
            </button>
          ))}
        </div>

        <div className="wf-editor">
          {unavailable && <p className="wf-hint">No safe suggestion found. Enter your own values.</p>}
          <div className="wf-fields">
            {scen !== 'rush' ? (
              <label className="field wf-order"><span className="field-label">Order</span>
                <select value={d.orderId} onChange={pickOrder}><option value="">Select an order…</option>{openOrders.map((o) => <option key={o.id} value={o.id}>{o.customerName} · {o.item}</option>)}</select>
              </label>
            ) : (
              <>
                <label className="field"><span className="field-label">Customer</span><input value={d.customerName} onChange={setField('customerName')} /></label>
                <label className="field"><span className="field-label">Item</span><input value={d.item} onChange={setField('item')} /></label>
                <label className="field"><span className="field-label">Prep (minutes)</span><input type="number" min="5" step="5" value={d.prep} onChange={setField('prep')} /></label>
                <label className="field"><span className="field-label">Deadline</span><input type="datetime-local" value={d.deadline} onChange={setField('deadline')} /></label>
              </>
            )}
          </div>
          {scen !== 'rush' && (
            <div className="wf-pair">
              <div className="wf-from"><span className="field-label">Current</span><b className="wf-mono">{!cur ? '—' : scen === 'deadline' ? T(cur.deadline) : prepText(cur.prepTimeMinutes)}</b></div>
              <span className="wf-to" aria-hidden="true">→</span>
              {scen === 'deadline'
                ? <label className="field wf-into"><span className="field-label">Proposed</span><input type="datetime-local" value={d.deadline} onChange={setField('deadline')} /></label>
                : <label className="field wf-into"><span className="field-label">Proposed (minutes)</span><input type="number" min="0" step="5" value={d.prep} onChange={setField('prep')} /></label>}
            </div>
          )}
          <button type="button" className="btn btn-primary wf-run" disabled={!valid || busy || !exps} onClick={run}><FlaskConical size={15} aria-hidden="true" />{busy ? 'Simulating…' : 'Run simulation'}</button>
        </div>
      </section>

      {error && <div className="notice error" role="alert">Couldn't run the simulation: {error.message}{error.details?.map((x, i) => <div key={i}>{x.field}: {x.message}</div>)}</div>}
      {done && <div className="notice ok" role="status">{done}</div>}

      {cmp && (
        <dl className="wf-metrics" aria-live="polite" aria-label="Impact">
          {metrics.map((m) => <div key={m.label} className={`is-${m.tone}`}><dt>{m.label}</dt><dd>{m.value}</dd><span className="wf-ind"><i aria-hidden="true" />{m.word}</span></div>)}
        </dl>
      )}
      {stale && <p className="wf-stale" role="status">Inputs changed. Run the simulation again to update.</p>}

      <section className="wf-table" aria-label="Order schedule">
        <div className="wf-tabs" role="tablist" aria-label="Schedule">
          <button type="button" role="tab" aria-selected={!showSim} className={!showSim ? 'is-on' : ''} onClick={() => setView('orig')}>Original schedule</button>
          <button type="button" role="tab" aria-selected={showSim} className={showSim ? 'is-on' : ''} disabled={!cmp} onClick={() => setView('sim')}>Simulated schedule</button>
          {cmp && <span className="wf-nosave">Not saved</span>}
        </div>
        <ul className="wf-rows">
          <li className="wf-cols" aria-hidden="true"><span>Order</span><span>Deadline</span><span>Prep</span><span>Predicted finish</span><span>Status</span></li>
          {rows.map((r) => <ScheduleRow key={r.id} r={r} sim={showSim} T={T} />)}
        </ul>
      </section>

      {cmp && (
        <div className="wf-actions">
          <button type="button" className="btn" onClick={discard} disabled={busy}>Discard simulation</button>
          {!confirming
            ? <button type="button" className="btn btn-primary" disabled={stale || busy || cmp.story.headline.tone === 'details'} onClick={() => setConfirming(true)}>Confirm changes</button>
            : (<><button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Not yet</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={apply}>{busy ? 'Saving…' : cmp.isNew ? 'Save as a real order' : sim.change.order.prepTimeMinutes !== undefined ? 'Save new prep time' : 'Save new deadline'}</button></>)}
        </div>
      )}
      {confirming && sim && <p className="wf-stale" role="status">{cmp.isNew ? 'This creates a real order.' : sim.change.order.prepTimeMinutes !== undefined ? `This changes the saved prep time on ${byId[sim.change.orderId]?.customerName}'s order.` : `This changes the saved deadline on ${byId[sim.change.orderId]?.customerName}'s order. Apply it once the customer agrees.`}</p>}
    </>
  );
}

function cmpStatus(o, planner) {
  const e = planner.schedule?.find((x) => x.orderId === o.id);
  if (!e) return { label: o.status === 'completed' ? 'Completed' : o.status === 'cancelled' ? 'Cancelled' : 'No schedule', tone: 'done' };
  if (e.kind === 'deadline_passed') return { label: 'Overdue', tone: 'late' };
  if (e.kind === 'unschedulable' || e.scheduledEnd == null) return { label: "Can't be scheduled", tone: 'late' };
  if (e.risk === 'high') return { label: 'Late', tone: 'late' };
  if (e.risk === 'medium') return { label: 'Tight', tone: 'warn' };
  return { label: 'On track', tone: 'ok' };
}

// A value that may differ: in the simulated view a changed value reads "old → new" with the new one in caramel.
function Val({ a, b, show, mono = true }) {
  const same = !show || String(a) === String(b);
  return same ? <span className={mono ? 'wf-mono' : ''}>{a}</span> : <span className={mono ? 'wf-mono' : ''}><s className="wf-old">{a}</s> <span className="wf-arrow" aria-hidden="true">→</span><span className="sr-only"> changed to </span> <b className="wf-new">{b}</b></span>;
}

function ScheduleRow({ r, sim, T }) {
  const o = r.orig; const n = r.sim ?? r.orig;
  const status = sim ? n.status : o.status;
  const cls = ['wf-row', sim && r.isNew ? 'is-new' : '', sim && r.target ? 'is-target' : '', status.tone === 'late' ? 'is-late' : '', status.tone === 'resolved' ? 'is-resolved' : ''].filter(Boolean).join(' ');
  const prepText = (v) => (v == null ? 'Not set' : formatMinutes(v));
  const flag = sim && r.isNew ? 'New' : sim && r.changed ? 'Changed' : null;
  return (
    <li className={cls}>
      <span className="wf-who"><strong>{r.name}{flag && <em className="wf-tag">{flag}</em>}</strong><span>{r.item}{r.quantity > 1 ? ` × ${r.quantity}` : ''}</span></span>
      <span className="wf-cell" data-label="Deadline"><Val a={T(o.deadline)} b={T(n.deadline)} show={sim && !r.isNew} /></span>
      <span className="wf-cell" data-label="Prep"><Val a={prepText(o.prep)} b={prepText(n.prep)} show={sim && !r.isNew} /></span>
      <span className="wf-cell" data-label="Predicted finish"><Val a={T(o.finish)} b={T(n.finish)} show={sim && !r.isNew} /></span>
      <span className="wf-cell" data-label="Status"><span className={`wf-st st-${status.tone}`}><i aria-hidden="true" />{sim && r.statusChanged && !r.isNew ? <><s className="wf-old">{o.status.label}</s> → {n.status.label}</> : status.label}</span></span>
    </li>
  );
}
