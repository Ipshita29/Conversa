import useWorkspace from '../hooks/useWorkspace.js';
import PageHeader from '../components/PageHeader.jsx';
import Reveal from '../components/Reveal.jsx';
import StateMessage from '../components/StateMessage.jsx';
import CapacitySection from '../components/CapacitySection.jsx';
import TodaySection from '../components/TodaySection.jsx';
import RiskSection from '../components/RiskSection.jsx';
import SimulationPanel from '../components/SimulationPanel.jsx';
import '../css/Operations.css';

export default function Operations() {
  const { status, data, error, reload } = useWorkspace();
  const header = <PageHeader eyebrow="Operations" title="Where your capacity stands." subtitle="Progress, deadline risks and what-if planning in one place." />;
  if (status === 'loading' && !data) return <section className="page operations">{header}<StateMessage kind="loading" message="Analysing workload…" /></section>;
  if (status === 'error') return <section className="page operations">{header}<StateMessage kind="error" message={`Couldn't load operations data. ${error.message}`} onRetry={reload} /></section>;

  const { dashboard, planner, orders } = data;
  if (dashboard.stats.total === 0) return <section className="page operations">{header}<StateMessage message="No orders yet, so there is nothing to plan." /></section>;

  return (
    <section className="page operations">
      {header}
      <Reveal as="section" className="ws-section"><CapacitySection planner={planner} />
        {planner.recommendations.length > 0 && (
          <div className="next-actions">
            <h3>Recommended next actions</h3>
            <ol className="plain-list">{planner.recommendations.map((r) => (
              <li key={r.id} className={`action action-${r.priority}`}><span className="action-pri">{r.priority}</span><div><strong>{r.action}</strong><p className="muted">{r.reason}</p></div></li>
            ))}</ol>
          </div>
        )}
      </Reveal>
      <Reveal as="section" className="ws-section"><TodaySection dashboard={dashboard} planner={planner} orders={orders} eyebrow="Progress" title="Today's progress." subtitle="What is due or scheduled today, and how far along it is." /></Reveal>
      <Reveal as="section" className="ws-section"><RiskSection planner={planner} orders={orders} /></Reveal>
      <Reveal as="section" className="ws-section"><SimulationPanel planner={planner} orders={orders} onApplied={reload} /></Reveal>
    </section>
  );
}
