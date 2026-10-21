import { Fragment, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, ChevronDown, FlaskConical, HelpCircle } from 'lucide-react';
import { formatInTz, formatMinutes, isDemoOrder } from '../utils/format.js';
import StateMessage from './StateMessage.jsx';
import { RiskBadge, StatusBadge } from './Badge.jsx';
import '../css/Timeline.css';

const RISK_OF = { deadline_passed: 'high', unschedulable: 'high', late: 'high', tight: 'medium', on_track: 'low' };
const qty = (o) => (o.quantity > 1 ? ` × ${o.quantity}` : '');

// Every number, ranking and sentence below comes from the scheduling engine (planner.nextMoves / planner.schedule).
// The sequence is the engine's own work queue (workSequence), never a re-sort by deadline in the browser.
function Step({ step, open, onToggle, tz, nowIso, byId, onSimulate }) {
  const id = useId();
  const { type, order, move, entry, number, isNext } = step;
  const overdue = move?.kind === 'deadline_passed';
  const overdueBy = overdue && nowIso ? Math.max(1, Math.round((Date.parse(nowIso) - Date.parse(order.deadline)) / 60000)) : null;
  const risk = move ? RISK_OF[move.kind] : null;
  const ahead = (entry?.precededBy ?? []).filter((p) => byId[p.orderId]);
  const tone = type === 'done' ? 'done' : type === 'blocked' ? 'details' : overdue ? 'overdue' : risk === 'high' ? 'late' : risk === 'medium' ? 'tight' : 'ok';

  return (
    <li className={`pt-step pt-${tone}${isNext ? ' is-next' : ''}${open ? ' is-open' : ''}`}>
      <span className="pt-marker" aria-hidden="true">
        {type === 'done' ? <Check size={18} strokeWidth={3} /> : type === 'blocked' ? <HelpCircle size={18} /> : number}
        {overdue && <i className="pt-flag">!</i>}
      </span>
      <div className="pt-main">
        <button type="button" className="pt-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <span className="pt-title">
            <span className="pt-tags">
              {isNext && <b className="pt-tag pt-tag-next">Next task</b>}
              {overdue && <b className="pt-tag pt-tag-overdue">Overdue{overdueBy ? ` by ${formatMinutes(overdueBy)}` : ''}</b>}
              {type === 'blocked' && <b className="pt-tag pt-tag-details">Not scheduled yet</b>}
              {isDemoOrder(order) && <b className="pt-tag pt-tag-demo">Demo</b>}
            </span>
            <strong>{order.customerName}</strong>
            <span className="pt-product">{order.item}{qty(order)}</span>
          </span>
          <span className="pt-meta">
            <span><small>Promised</small>{order.deadline ? formatInTz(order.deadline, tz) : 'Not set'}</span>
            <span><small>Preparation</small>{order.prepTimeMinutes === null ? 'Not set' : formatMinutes(order.prepTimeMinutes)}</span>
          </span>
          <span className="pt-badges">
            {type === 'done' ? <StatusBadge status={order.status} /> : type === 'blocked' ? <RiskBadge needsDetails /> : <RiskBadge risk={risk} />}
            {type === 'queue' && <StatusBadge status={order.status} />}
          </span>
          <ChevronDown size={18} className="pt-chev" aria-hidden="true" />
        </button>

        {open && (
          <div id={id} className="pt-body">
            {type === 'done' ? (
              <p>This order is complete. No action needed.</p>
            ) : (
              <>
                <div className="pt-why">
                  <h4>{type === 'blocked' ? 'Why it is not scheduled' : `Why it is number ${number}`}</h4>
                  <p>{move.why}</p>
                  {type === 'queue' && (
                    <ul>
                      {ahead.length > 0
                        ? <li>Scheduled behind {ahead.map((p, i) => <span key={p.orderId}>{i > 0 && ', '}{byId[p.orderId].customerName} ({formatMinutes(p.minutes)})</span>)}.</li>
                        : <li>Nothing is scheduled ahead of it.</li>}
                      {entry && <li>Planned from {formatInTz(entry.scheduledStart, tz)}{entry.scheduledEnd ? ` to ${formatInTz(entry.scheduledEnd, tz)}` : ''}.</li>}
                      {entry?.bufferMinutes != null && <li>{entry.bufferMinutes < 0 ? `Finishes ${formatMinutes(-entry.bufferMinutes)} after the promised deadline.` : `Finishes ${formatMinutes(entry.bufferMinutes)} before the promised deadline.`}</li>}
                    </ul>
                  )}
                </div>
                <div className="pt-next">
                  <h4>Next recommended action</h4>
                  <p className="pt-action">{move.action}</p>
                  {move.recovery && <p className="pt-recovery"><b>Recovery:</b> {move.recovery}</p>}
                  <div className="pt-cta">
                    <Link className="btn btn-primary btn-sm" to={`/orders?edit=${order.id}`}>{type === 'blocked' ? 'Update order' : 'Open order'} <ArrowRight size={14} aria-hidden="true" /></Link>
                    {onSimulate && order.deadline && ['late', 'tight', 'deadline_passed'].includes(move.kind) && (
                      <button type="button" className="btn btn-sm" onClick={() => onSimulate({ orderId: order.id, deadline: order.deadline })}><FlaskConical size={14} aria-hidden="true" />Simulate a change</button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export default function DeadlineTimeline({ planner, orders, onSimulate }) {
  const tz = planner.range.timezone;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const moves = (planner.nextMoves ?? []).filter((m) => byId[m.orderId]);
  const entryOf = Object.fromEntries((planner.schedule ?? []).map((e) => [e.orderId, e]));

  const queue = moves.filter((m) => m.workSequence != null).sort((a, b) => a.workSequence - b.workSequence); // the engine's work queue
  const blocked = moves.filter((m) => m.workSequence == null); // missing prep time or deadline: unscheduled
  const done = orders.filter((o) => o.status === 'completed').sort((a, b) => new Date(a.deadline ?? 0) - new Date(b.deadline ?? 0));

  const steps = [
    ...done.map((o) => ({ key: o.id, type: 'done', order: o })),
    ...queue.map((m, i) => ({ key: m.orderId, type: 'queue', order: byId[m.orderId], move: m, entry: entryOf[m.orderId], number: m.workSequence, isNext: i === 0 })),
    ...blocked.map((m) => ({ key: m.orderId, type: 'blocked', order: byId[m.orderId], move: m })),
  ];
  const nextStep = steps.find((s) => s.isNext);
  const [open, setOpen] = useState(nextStep?.key ?? null);

  if (!outdated(planner) && steps.length === 0) return <StateMessage message={orders.length === 0 ? 'No orders yet, so there is no timeline to show.' : 'Nothing to schedule: every order is closed.'} />;
  if (outdated(planner)) return <StateMessage kind="error" message="Your server is running an older version of the scheduler, so it can't build the timeline."><p className="moves-hint">Stop the server and run <code>npm run dev</code> in the <code>server</code> folder.</p></StateMessage>;

  const overdue = queue.filter((m) => m.kind === 'deadline_passed');
  const firstQueue = steps.findIndex((s) => s.type === 'queue');
  const firstBlocked = steps.findIndex((s) => s.type === 'blocked');

  return (
    <div className="pt-wrap">
      <div className="pt-card">
        <div className="pt-summary">
          <div className="pt-sum pt-sum-next">
            <small>Recommended next task</small>
            {nextStep ? <><strong>{nextStep.order.customerName}</strong><span>{nextStep.move.action}</span></> : <span>Nothing is waiting to be worked on.</span>}
          </div>
          <div className={`pt-sum ${overdue.length ? 'pt-sum-overdue' : 'pt-sum-clear'}`}>
            <small>Already overdue</small>
            {overdue.length
              ? <><strong>{overdue.length} {overdue.length === 1 ? 'order' : 'orders'}</strong><span>{overdue.map((m) => byId[m.orderId].customerName).join(', ')}: contact the customer, then finish the work.</span></>
              : <span>Nothing is overdue.</span>}
          </div>
        </div>

        <ol className="pt-steps">
          {steps.map((s, i) => (
            <Fragment key={s.key}>
              {i === 0 && s.type === 'done' && <li className="pt-group"><p>Completed</p></li>}
              {i === firstQueue && <li className="pt-group"><p>Recommended order of work</p></li>}
              {i === firstBlocked && <li className="pt-group"><p>Waiting on details</p></li>}
              <Step step={s} open={open === s.key} onToggle={() => setOpen(open === s.key ? null : s.key)} tz={tz} nowIso={planner.generatedAt} byId={byId} onSimulate={onSimulate} />
            </Fragment>
          ))}
        </ol>
        <p className="pt-foot muted">Numbers are the scheduler's work queue: earliest deadline first, inside your working hours and daily capacity. Orders without a preparation time or deadline stay unscheduled until you add them.</p>
      </div>
    </div>
  );
}

function outdated(planner) { return !Array.isArray(planner.nextMoves); }
