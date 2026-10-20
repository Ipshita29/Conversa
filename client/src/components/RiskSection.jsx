import { Link } from 'react-router-dom';
import { formatInTz, formatMinutes } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';
import StateMessage from './StateMessage.jsx';
import { RiskBadge } from './Badge.jsx';

const NEEDS = { missing_prep_time: 'Add a preparation time so it can be scheduled.', missing_deadline: 'Add a deadline so it can be scheduled.', missing_both: 'Add a deadline and a preparation time so it can be scheduled.' };

function Row({ order, entry, next, tz, kind }) {
  const late = entry && entry.bufferMinutes !== null && entry.bufferMinutes < 0;
  return (
    <li className={`risk-row risk-row-${kind}`}>
      <div className="risk-who">
        <strong>{order.customerName}</strong>
        <span>{order.item}{order.quantity > 1 ? ` × ${order.quantity}` : ''}</span>
      </div>
      <div className="risk-times">
        <span><small>Deadline</small>{order.deadline ? formatInTz(order.deadline, tz) : '—'}</span>
        {entry && (entry.scheduledEnd || entry.scheduledStart) && <span><small>Estimated finish</small>{entry.scheduledEnd ? formatInTz(entry.scheduledEnd, tz) : 'Not within 60 days'}</span>}
        {entry && entry.bufferMinutes !== null && <span><small>{late ? 'Late by' : 'Buffer'}</small>{formatMinutes(Math.abs(entry.bufferMinutes))}</span>}
      </div>
      <div className="risk-why">
        <RiskBadge risk={kind === 'details' ? null : entry.risk} needsDetails={kind === 'details'} />
        <p>{kind === 'details' ? next : entry.reason}</p>
        {kind !== 'details' && next && <p className="risk-next"><b>Next step:</b> {next}</p>}
        {kind !== 'details' && entry.suggestedDeadline && <p className="risk-next"><b>Suggested deadline:</b> {formatInTz(entry.suggestedDeadline, tz)}</p>}
        {kind === 'details' && <Link to="/orders" className="btn btn-ghost btn-sm">Edit in Orders</Link>}
      </div>
    </li>
  );
}

// Everything shown here is the scheduling engine's output (planner API); nothing is recalculated in the browser.
export default function RiskSection({ planner, orders, eyebrow = 'Deadlines', title = "Let's protect your deadlines.", subtitle = 'See which orders need attention, what is causing the conflict, and what you can do next.' }) {
  const tz = planner.range.timezone;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const schedule = planner.schedule ?? [];
  const entryById = Object.fromEntries(schedule.map((s) => [s.orderId, s]));
  const recFor = (id) => planner.recommendations.find((r) => r.orderId === id)?.action ?? null;

  const high = planner.risks.filter((r) => r.risk === 'high');
  const medium = planner.risks.filter((r) => r.risk === 'medium');
  const low = schedule.filter((s) => s.risk === 'low');
  const details = planner.unscheduledOrders;
  const total = high.length + medium.length + low.length + details.length;

  const group = (label, hint, items, render, kind) => items.length > 0 && (
    <section className={`risk-group risk-group-${kind}`} aria-label={label}>
      <h3>{label} <span>{items.length}</span></h3>
      <p className="muted">{hint}</p>
      <ul className="plain-list">{items.map(render)}</ul>
    </section>
  );
  const riskRow = (kind) => (r) => {
    const id = r.orderId;
    const entry = entryById[id] ?? r;
    return byId[id] && <Row key={id} order={byId[id]} entry={entry} next={recFor(id)} tz={tz} kind={kind} />;
  };

  return (
    <>
      <SectionHead eyebrow={eyebrow} title={title}>{subtitle}</SectionHead>
      {total === 0 ? (
        <StateMessage message="No open orders to schedule." />
      ) : (
        <div className="risk-groups">
          {group('High risk', 'Estimated to finish after the deadline, or the deadline has passed.', high, riskRow('high'), 'high')}
          {group('Medium risk', 'Fits, but with less than four hours to spare.', medium, riskRow('medium'), 'medium')}
          {group('Needs details', 'Left out of scheduling until a deadline and preparation time are set. Nothing is guessed.', details, (u) => byId[u.id] && <Row key={u.id} order={byId[u.id]} next={NEEDS[u.reason]} tz={tz} kind="details" />, 'details')}
          {group('On track', 'Comfortable buffer before the deadline.', low, riskRow('low'), 'low')}
        </div>
      )}
    </>
  );
}
