import { useCallback, useEffect, useState } from 'react';
import { getDashboard } from '../services/dashboardService.js';
import StatCard from '../components/StatCard.jsx';
import Panel from '../components/Panel.jsx';
import StateMessage from '../components/StateMessage.jsx';
import WorkloadChart from '../components/WorkloadChart.jsx';
import '../css/Dashboard.css';

const fmtDeadline = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function timeLeft(iso) {
  const h = Math.round((new Date(iso) - Date.now()) / 36e5);
  if (h < 0) return 'Overdue';
  return h < 24 ? `${h}h left` : `${Math.round(h / 24)}d left`;
}

export default function Dashboard() {
  const [state, setState] = useState({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    getDashboard()
      .then(({ data, isDemo }) => setState({ status: 'ready', data, isDemo }))
      .catch((err) => setState({ status: 'error', message: err.message }));
  }, []);

  useEffect(load, [load]);

  if (state.status === 'loading') return <section className="page dashboard"><StateMessage kind="loading" message="Loading dashboard…" /></section>;
  if (state.status === 'error') return <section className="page dashboard"><StateMessage kind="error" message={`Couldn't load the dashboard. ${state.message}`} onRetry={load} /></section>;

  const { stats, workload, urgentOrders, upcomingDeadlines, recommendations } = state.data;
  const isEmpty = stats.total === 0;
  const usedPct = workload.availableHours ? Math.round((workload.pendingHours / workload.availableHours) * 100) : 0;
  const overloaded = workload.pendingHours > workload.availableHours;

  return (
    <section className="page dashboard">
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Your orders, workload, and what to do next.</p>
        </div>
        {state.isDemo && <span className="demo-badge" title="Mock data from client/src/mock">Demo data</span>}
      </header>

      {isEmpty ? (
        <StateMessage message="No orders yet. Once orders come in, your dashboard will appear here." />
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
            <Panel title="Workload" subtitle="Pending preparation vs. available working hours">
              <p className="workload-figure">
                <strong>{workload.pendingHours}h</strong> of {workload.availableHours}h <span className="muted">({usedPct}%)</span>
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
                      <div>
                        <strong>{r.action}</strong>
                        <p>{r.reason}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>

            <Panel title="Urgent orders">
              {urgentOrders.length === 0 ? (
                <StateMessage message="No urgent orders." />
              ) : (
                <ul className="order-list">
                  {urgentOrders.map((o) => (
                    <li key={o.id}>
                      <div>
                        <strong>{o.customer}</strong> <span className="muted">{o.id}</span>
                        <p>{o.item}</p>
                        <small className="muted">{o.status} · {o.prepHours}h prep</small>
                      </div>
                      <div className="order-meta">
                        <span className={`pill risk-${o.risk}`}>{o.risk} risk</span>
                        <small>{timeLeft(o.deadline)}</small>
                      </div>
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
                    <li key={d.id}>
                      <span><strong>{d.customer}</strong> <span className="muted">{d.id}</span></span>
                      <time dateTime={d.deadline}>{fmtDeadline(d.deadline)}</time>
                    </li>
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
