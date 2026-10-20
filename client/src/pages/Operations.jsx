import { Link } from 'react-router-dom';
import { getPlanner, listOrders } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatMinutes, formatDateTime, formatDate, timeLeft } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import Panel from '../components/Panel.jsx';
import StatCard from '../components/StatCard.jsx';
import StateMessage from '../components/StateMessage.jsx';
import { RiskBadge, StatusBadge, PaymentBadge } from '../components/Badge.jsx';
import '../css/Operations.css';

const RANK = { high: 0, medium: 1, low: 2 };
const REASON = { missing_prep_time: 'Add a preparation time', missing_deadline: 'Add a deadline', missing_both: 'Add a preparation time and deadline' };

export default function Operations() {
  const { status, data, error, reload } = useAsync(async () => {
    const [planner, orders] = await Promise.all([getPlanner({ days: 14 }), listOrders({ status: 'pending,confirmed,in_progress', pageSize: 100 })]);
    return { planner, orders: orders.items };
  });

  const header = <PageHeader title="Operations" subtitle="Where your capacity is under pressure and what to do about it." />;
  if (status === 'loading' && !data) return <section className="page operations">{header}<StateMessage kind="loading" message="Analysing workload…" /></section>;
  if (status === 'error') return <section className="page operations">{header}<StateMessage kind="error" message={`Couldn't load operations data. ${error.message}`} onRetry={reload} /></section>;

  const { planner, orders } = data;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const fullDays = planner.days.filter((d) => d.capacityMinutes > 0 && d.plannedMinutes >= d.capacityMinutes);
  const high = planner.risks.filter((r) => r.risk === 'high').length;
  const queue = [...orders].sort((a, b) => (RANK[a.risk] ?? 3) - (RANK[b.risk] ?? 3) || (a.deadline ? new Date(a.deadline) : Infinity) - (b.deadline ? new Date(b.deadline) : Infinity));

  if (orders.length === 0) return <section className="page operations">{header}<StateMessage message="No open orders — nothing to prioritise." /></section>;

  return (
    <section className="page operations">
      {header}
      <div className="stat-grid">
        <StatCard label="Utilisation (14 days)" value={`${planner.workload.utilisationPercent}%`} tone={planner.workload.utilisationPercent > 100 ? 'danger' : 'info'} />
        <StatCard label="High-risk orders" value={high} tone="danger" />
        <StatCard label="Medium-risk orders" value={planner.risks.length - high} tone="warn" />
        <StatCard label="Fully booked days" value={fullDays.length} tone="warn" />
        <StatCard label="Missing details" value={planner.unscheduledOrders.length} />
      </div>

      <div className="grid-2">
        <Panel title="Recommended next actions" subtitle="Rule-based, most urgent first">
          {planner.recommendations.length === 0 ? <StateMessage message="Nothing needs attention." /> : (
            <ol className="reco-list">{planner.recommendations.map((r) => (
              <li key={r.id} className={`reco reco-${r.priority}`}><span className="pill">{r.priority}</span>
                <div><strong>{r.action}</strong><p>{r.reason}</p></div></li>
            ))}</ol>
          )}
        </Panel>

        <Panel title="Deadline conflicts" subtitle="Orders that may miss their deadline">
          {planner.risks.length === 0 ? <StateMessage message="No conflicts detected." /> : (
            <ul className="plain-list">{planner.risks.map((r) => {
              const o = byId[r.orderId];
              return (
                <li key={r.orderId} className="conflict">
                  <RiskBadge risk={r.risk} />
                  <div><strong>{o?.customerName}</strong> <span className="muted">{o?.item}</span>
                    <p className="muted">{r.reason} {o?.deadline && `Due ${formatDateTime(o.deadline)} (${timeLeft(o.deadline)}).`}</p></div>
                </li>
              );
            })}</ul>
          )}
          <Link className="btn btn-sm" to="/calendar">Simulate a change in Calendar</Link>
        </Panel>

        <Panel title="Priority queue" subtitle="Open orders ranked by risk, then deadline">
          <ol className="queue">{queue.map((o, i) => (
            <li key={o.id}>
              <span className="queue-n">{i + 1}</span>
              <div className="queue-body"><strong>{o.customerName}</strong> <span className="muted">{o.item}</span>
                <div className="queue-tags"><RiskBadge risk={o.risk} /><StatusBadge status={o.status} /><PaymentBadge status={o.paymentStatus} /></div></div>
              <small className="queue-meta">{o.deadline ? timeLeft(o.deadline) : 'No deadline'}<br />{formatMinutes(o.prepTimeMinutes)}</small>
            </li>
          ))}</ol>
        </Panel>

        <div className="ops-col">
          <Panel title="Capacity pressure" subtitle="Days at or near full capacity">
            {planner.days.filter((d) => d.capacityMinutes > 0 && d.plannedMinutes / d.capacityMinutes >= 0.85).length === 0 ? <StateMessage message="No days are close to full." /> : (
              <ul className="plain-list">{planner.days.filter((d) => d.capacityMinutes > 0 && d.plannedMinutes / d.capacityMinutes >= 0.85).map((d) => (
                <li key={d.date}><div className="pressure-row"><strong>{formatDate(d.date)}</strong><small>{formatMinutes(d.plannedMinutes)} / {formatMinutes(d.capacityMinutes)}</small></div>
                  <div className="meter"><div className={d.plannedMinutes >= d.capacityMinutes ? 'meter-fill over' : 'meter-fill'} style={{ width: `${Math.min(100, (d.plannedMinutes / d.capacityMinutes) * 100)}%` }} /></div></li>
              ))}</ul>
            )}
          </Panel>
          <Panel title="Needs details" subtitle="Excluded from planning until completed">
            {planner.unscheduledOrders.length === 0 ? <StateMessage message="All open orders are fully specified." /> : (
              <ul className="plain-list">{planner.unscheduledOrders.map((u) => (
                <li key={u.id}><strong>{byId[u.id]?.customerName}</strong> <span className="muted">{byId[u.id]?.item}</span><p className="muted">{REASON[u.reason]}. <Link to="/orders">Edit in Orders</Link></p></li>
              ))}</ul>
            )}
          </Panel>
        </div>
      </div>
    </section>
  );
}
