import { useState } from 'react';
import useWorkspace from '../hooks/useWorkspace.js';
import useHashScroll from '../hooks/useHashScroll.js';
import { scrollToSection } from '../utils/scroll.js';
import Reveal from '../components/Reveal.jsx';
import SectionHead from '../components/SectionHead.jsx';
import StateMessage from '../components/StateMessage.jsx';
import DemoBadge from '../components/DemoBadge.jsx';
import DeadlineTimeline from '../components/DeadlineTimeline.jsx';
import RiskSection from '../components/RiskSection.jsx';
import SimulationPanel from '../components/SimulationPanel.jsx';
import '../css/Deadlines.css';

const plural = (n, one, many) => (n === 1 ? one : many);

// One plain sentence about where production stands, counted from the engine's own classification of each order.
function situation(planner) {
  const moves = planner.nextMoves;
  if (!Array.isArray(moves)) return null;
  const queued = moves.filter((m) => m.workSequence != null).length;
  const n = (kind) => moves.filter((m) => m.kind === kind).length;
  const overdue = n('deadline_passed'); const late = n('late') + n('unschedulable'); const tight = n('tight'); const blocked = n('needs_details');
  if (queued === 0 && blocked === 0) return 'Nothing is waiting to be made right now.';
  const parts = [];
  if (queued) parts.push(`${queued} ${plural(queued, 'order is', 'orders are')} lined up for production, in the order the scheduler recommends.`);
  if (overdue) parts.push(`${overdue} ${plural(overdue, 'is', 'are')} already overdue.`);
  if (late) parts.push(`${late} ${plural(late, 'is', 'are')} predicted to miss ${plural(late, 'its deadline', 'their deadlines')}.`);
  if (tight) parts.push(`${tight} ${plural(tight, 'has', 'have')} a thin buffer.`);
  if (blocked) parts.push(`${blocked} ${plural(blocked, 'is', 'are')} waiting on details and left out of the schedule.`);
  if (!overdue && !late && !tight) parts.push('Everything scheduled is on track.');
  return parts.join(' ');
}

export default function Deadlines() {
  const { status, data, error, reload } = useWorkspace();
  const [prefill, setPrefill] = useState(null);
  useHashScroll(Boolean(data));
  const simulate = (p) => { setPrefill({ ...p, nonce: Date.now() }); scrollToSection('simulation'); };

  if (status === 'loading' && !data) return <section className="page deadlines"><StateMessage kind="loading" message="Building your timeline…" /></section>;
  if (status === 'error') return <section className="page deadlines"><StateMessage kind="error" message={`Couldn't load your deadlines. ${error.message}`} onRetry={reload} /></section>;

  const { planner, orders } = data;
  return (
    <section className="page deadlines">
      <Reveal as="section" id="timeline" className="ws-section" from="right">
        <SectionHead eyebrow="Deadlines" title="Let's protect your deadlines.">{situation(planner) ?? 'The scheduler has not described your production yet.'}</SectionHead>
        <div className="dl-demo"><DemoBadge /></div>
      </Reveal>
      <Reveal as="div" className="dl-timeline"><DeadlineTimeline planner={planner} orders={orders} onSimulate={simulate} /></Reveal>

      <Reveal as="section" id="risk" className="ws-section">
        <RiskSection planner={planner} orders={orders} onSimulate={simulate} eyebrow="At risk" title="Orders at risk." subtitle="The reasons, the expected finish times, and what you can do about each one." />
      </Reveal>
      <Reveal as="section" id="simulation" className="ws-section">
        <SimulationPanel planner={planner} orders={orders} onApplied={reload} prefill={prefill} eyebrow="What-if" title="What if we changed the plan?" subtitle="Try the experiment the scheduler suggests, or build your own. Nothing is saved until you confirm it." />
      </Reveal>
    </section>
  );
}
