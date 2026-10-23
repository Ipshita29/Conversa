import { Link, useNavigate } from 'react-router-dom';
import useWorkspace from '../hooks/useWorkspace.js';
import StateMessage from '../components/StateMessage.jsx';
import RiskSection from '../components/RiskSection.jsx';
import '../css/Plan.css';

// The detailed view kept off the Plan page: every at-risk order with its reasoning.
export default function Risks() {
  const { status, data, error, reload } = useWorkspace();
  const navigate = useNavigate();
  if (status === 'loading' && !data) return <section className="page"><StateMessage kind="loading" message="Loading…" /></section>;
  if (status === 'error') return <section className="page"><StateMessage kind="error" message={`Couldn't load the risk breakdown. ${error.message}`} onRetry={reload} /></section>;
  const simulate = (prefill) => navigate('/whatif', { state: { prefill: { ...prefill, nonce: Date.now() } } });
  const { planner, orders } = data;
  return (
    <section className="page risks">
      <p className="pl-back"><Link to="/plan">← Back to the plan</Link></p>
      <RiskSection planner={planner} orders={orders} onSimulate={simulate} eyebrow="At risk" title="Orders at risk." subtitle="Expected finish times, the cause of each conflict, and what you can do." />
    </section>
  );
}
