import { Link } from 'react-router-dom';
import { getDashboard } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatMinutes, formatDateTime, timeLeft } from '../utils/format.js';
import StatCard from '../components/StatCard.jsx';
import Panel from '../components/Panel.jsx';
import PageHeader from '../components/PageHeader.jsx';
import StateMessage from '../components/StateMessage.jsx';
import WorkloadChart from '../components/WorkloadChart.jsx';
import { RiskBadge, StatusBadge } from '../components/Badge.jsx';
import '../css/Dashboard.css';

export default function Dashboard() {
  const { status, data, error, reload } = useAsync(getDashboard);

  const header = <PageHeader title="Dashboard" subtitle="Your orders, workload, and what to do next." />;
  if (status === 'loading' && !data) return <section className="page dashboard">{header}<StateMessage kind="loading" message="Loading dashboard…" /></section>;
  if (status === 'error') return <section className="page dashboard">{header}<StateMessage kind="error" message={`Couldn't load the dashboard. ${error.message}`} onRetry={reload} /></section>;

  const { stats, workload, urgentOrders, upcomingDeadlines, recommendations } = data;
  const usedPct = workload.availableMinutes ? Math.round((workload.pendingMinutes / workload.availableMinutes) * 100) : 0;
  const overloaded = workload.pendingMinutes > workload.availableMinutes;

  return (
    <section className="page dashboard">
      {header}
      {stats.total === 0 ? (
        <StateMessage message="No orders yet. Once orders come in, your dashboard will appear here.">
          <Link className="btn btn-primary" to="/orders">Add your first order</Link>
        </StateMessage>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Total orders" value={stats.total} />
            <StatCard label="Pending" value={stats.pending} tone="warn" />
            <StatCard label="In progress" value={stats.inProgress} tone="info" />
            <StatCard label="Completed" value={stats.completed} tone="ok" />
            <StatCard label="At risk" value={stats.atRisk} tone="danger" />
          </div>

          <div className="dash-grid">
            <Panel title="Workload" subtitle="Pending preparation vs. available working hours (next 7 days)">
              <p className="workload-figure">
                <strong>{formatMinutes(workload.pendingMinutes)}</strong> of {formatMinutes(workload.availableMinutes)} <span className="muted">({usedPct}%)</span>
              </p>
              <div className="meter" role="progressbar" aria-valuenow={Math.min(usedPct, 100)} aria-valuemin="0" aria-valuemax="100" aria-label="Workload used">
                <div className={overloaded ? 'meter-fill over' : 'meter-fill'} style={{ width: `${Math.min(usedPct, 100)}%` }} />
              </div>
              <WorkloadChart daily={workload.daily} />
            </Panel>

            <Panel title="Next actions" subtitle="Prioritised recommendations">
              {recommendations.length === 0 ? (
                <StateMessage message="You're all caught up." />
              ) : (
                <ol className="reco-list">
                  {recommendations.map((r) => (
                    <li key={r.id} className={`reco reco-${r.priority}`}>
                      <span className="pill">{r.priority}</span>
                      <div><strong>{r.action}</strong><p>{r.reason}</p></div>
                    </li>
                  ))}
                </ol>
              )}
              <Link className="btn btn-sm" to="/operations">Open Operations</Link>
            </Panel>

            <Panel title="Urgent orders">
              {urgentOrders.length === 0 ? (
                <StateMessage message="No urgent orders." />
              ) : (
                <ul className="order-list">
                  {urgentOrders.map((o) => (
                    <li key={o.id}>
                      <div>
                        <strong>{o.customerName}</strong>
                        <p>{o.item}</p>
                        <small className="muted"><StatusBadge status={o.status} /> {formatMinutes(o.prepTimeMinutes)} prep</small>
                      </div>
                      <div className="order-meta"><RiskBadge risk={o.risk} /><small>{timeLeft(o.deadline)}</small></div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Upcoming deadlines">
              {upcomingDeadlines.length === 0 ? (
                <StateMessage message="No upcoming deadlines." />
              ) : (
                <ul className="deadline-list">
                  {upcomingDeadlines.map((d) => (
                    <li key={d.id}><strong>{d.customerName}</strong><time dateTime={d.deadline}>{formatDateTime(d.deadline)}</time></li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </section>
  );
}
