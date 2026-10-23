import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import useAsync from '../hooks/useAsync.js';
import { getConversations } from '../services/api.js';
import SectionHead from './SectionHead.jsx';
import StateMessage from './StateMessage.jsx';
import { summarise } from '../utils/homeSummary.js';
import { formatDayInTz, formatInTz, formatMinutes, formatTimeInTz, isDemoOrder, STATUS_LABEL } from '../utils/format.js';
import '../css/Workspace.css';

const plural = (n, one, many) => (n === 1 ? one : many);
const MISSING = { missing_prep_time: 'preparation time', missing_deadline: 'deadline', missing_both: 'preparation time and deadline' };
const MAX_ISSUES = 3;
const MAX_UPCOMING = 3;

// Under the hero: how busy am I, what needs attention, what should I do next. Everything is derived from the planner and orders
// the API already returns (see utils/homeSummary.js); the scheduler's own ranking decides what comes first.
export default function DayWorkspace({ planner, orders }) {
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
        <section className="dw-sec" aria-labelledby="dw-attn">
          <div className="dw-sec-head"><h3 id="dw-attn">Needs your attention</h3>{attention > MAX_ISSUES && <Link to={attentionTo} className="dw-all">View all {attention} <ArrowRight size={14} aria-hidden="true" /></Link>}</div>
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

        <section className="dw-sec dw-next" aria-labelledby="dw-next">
          <div className="dw-sec-head"><h3 id="dw-next">Recommended next step</h3></div>
          {nextStep ? (
            <>
              <p className="dw-next-action">{nextStep.top.action}</p>
              <p className="dw-next-why">{nextStep.top.why}</p>
              <Link to={nextStep.to} className="btn btn-primary">{nextStep.label} <ArrowRight size={16} aria-hidden="true" /></Link>
            </>
          ) : <p className="dw-clear">Nothing is waiting on you right now.</p>}
        </section>
      </div>

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
  );
}
