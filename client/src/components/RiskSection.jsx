import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, FlaskConical, Pencil, Info } from 'lucide-react';
import { formatInTz, formatLongInTz, formatMinutes } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';
import StateMessage from './StateMessage.jsx';
import Modal from './Modal.jsx';
import CountUp from './CountUp.jsx';
import RiskTimeline from './RiskTimeline.jsx';
import { RiskBadge } from './Badge.jsx';
import '../css/Risk.css';

const MISSING = { missing_prep_time: 'preparation time', missing_deadline: 'deadline', missing_both: 'preparation time and deadline' };
const plural = (n, one, many) => (n === 1 ? one : many);
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
export default function RiskSection({ planner, orders, onSimulate, eyebrow = 'Orders at risk', title = "Let's protect your deadlines.", subtitle = 'See which orders need attention, what is causing the conflict, and what you can do next.' }) {
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
