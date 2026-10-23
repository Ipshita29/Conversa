import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import SectionHead from './SectionHead.jsx';
import StateMessage from './StateMessage.jsx';
import { RiskBadge, StatusBadge } from './Badge.jsx';
import { dateKey, formatInTz, formatMinutes, formatTimeInTz, OPEN, isDemoOrder } from '../utils/format.js';
import '../css/Workspace.css';

const MISSING = { missing_prep_time: 'preparation time', missing_deadline: 'deadline', missing_both: 'preparation time and deadline' };
const RISK_RANK = { deadline_passed: 0, late: 1, unschedulable: 1, tight: 2 };

// Under the hero: three numbers, what needs attention, and today's plan. Every figure comes from the planner and orders the API
// already returns; nothing is recalculated here.
export default function DayWorkspace({ dashboard, planner, orders }) {
  const tz = planner.range.timezone;
  const today = planner.days[0].date;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const open = orders.filter((o) => OPEN.includes(o.status));
  const dueToday = open.filter((o) => o.deadline && dateKey(o.deadline, tz) === today).length;
  const stats = dashboard.stats;

  const risky = planner.schedule.filter((e) => e.risk !== 'low' && byId[e.orderId])
    .sort((a, b) => (RISK_RANK[a.kind] ?? 3) - (RISK_RANK[b.kind] ?? 3) || new Date(a.deadline) - new Date(b.deadline));
  const blocked = planner.unscheduledOrders.filter((u) => byId[u.id]);
  const attention = [
    ...risky.map((e) => ({ id: e.orderId, o: byId[e.orderId], tone: e.risk, deadline: e.deadline, finish: e.scheduledEnd, reason: e.reason, overdue: e.kind === 'deadline_passed' })),
    ...blocked.map((u) => ({ id: u.id, o: byId[u.id], tone: 'details', deadline: byId[u.id].deadline, finish: null, reason: `Missing ${MISSING[u.reason]}, so it can't be scheduled yet.` })),
  ];
  const plan = planner.days[0].orders.filter((b) => byId[b.id]).sort((a, b) => new Date(a.start) - new Date(b.start));
  const riskOf = Object.fromEntries(planner.schedule.map((e) => [e.orderId, e.risk]));
  const cta = attention.length ? 'Review at-risk orders' : "View today's plan";

  if (stats.total === 0) return <StateMessage message="No orders yet. Add your first order, or draft one from a customer message."><Link className="btn btn-primary" to="/orders">Go to Orders</Link></StateMessage>;

  return (
    <div className="dw">
      <SectionHead eyebrow="Today" title="Your day, organised." />
      <dl className="dw-metrics">
        <div><dt>Due today</dt><dd>{dueToday}</dd></div>
        <div className={stats.atRisk ? 'is-risk' : ''}><dt>At risk</dt><dd>{stats.atRisk}</dd></div>
        <div><dt>Left to prepare</dt><dd>{open.length}</dd></div>
      </dl>

      {attention.length > 0 && (
        <section className="dw-block" aria-labelledby="dw-attn">
          <h3 id="dw-attn">Needs attention <span>{attention.length}</span></h3>
          <ul className="dw-attn">
            {attention.slice(0, 4).map((a) => (
              <li key={a.id} className={`dw-attn-${a.tone}`}>
                <div className="dw-main"><strong>{a.o.customerName}</strong><span>{a.o.item}{a.o.quantity > 1 ? ` × ${a.o.quantity}` : ''}</span></div>
                <div className="dw-when">
                  <span>{a.overdue ? 'Overdue · ' : 'Due '}{a.deadline ? formatInTz(a.deadline, tz) : 'no deadline'}</span>
                  {a.finish && <span>{a.overdue ? 'Earliest finish ' : 'Predicted finish '}{formatInTz(a.finish, tz)}</span>}
                </div>
                <RiskBadge risk={a.tone === 'details' ? null : a.tone} needsDetails={a.tone === 'details'} />
                <p className="dw-why">{a.reason}</p>
              </li>
            ))}
          </ul>
          {attention.length > 4 && <Link to="/plan" className="dw-more">{attention.length - 4} more <ArrowRight size={14} aria-hidden="true" /></Link>}
        </section>
      )}

      <section className="dw-block" aria-labelledby="dw-plan">
        <h3 id="dw-plan">Today's plan</h3>
        {plan.length === 0 ? <p className="dw-empty">Nothing is scheduled for today.</p> : (
          <ol className="dw-plan">
            {plan.map((b) => {
              const o = byId[b.id];
              return (
                <li key={b.id}>
                  <time className="dw-time" dateTime={b.start}>{formatTimeInTz(b.start, tz)}</time>
                  <div className="dw-main"><strong>{o.customerName}{isDemoOrder(o) && <span className="demo-tag">Demo</span>}</strong><span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></div>
                  <div className="dw-meta"><span>{formatMinutes(o.prepTimeMinutes ?? b.scheduledMinutes)} prep</span><span>Due {formatInTz(o.deadline, tz)}</span></div>
                  <div className="dw-badges"><StatusBadge status={o.status} />{(riskOf[o.id] === 'high' || riskOf[o.id] === 'medium') && <RiskBadge risk={riskOf[o.id]} />}</div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <Link to="/plan" className="btn btn-primary">{cta} <ArrowRight size={16} aria-hidden="true" /></Link>
    </div>
  );
}
