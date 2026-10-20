import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import useWorkspace from '../hooks/useWorkspace.js';
import { scrollToSection } from '../utils/scroll.js';
import Reveal from '../components/Reveal.jsx';
import StateMessage from '../components/StateMessage.jsx';
import HeroSection from '../components/HeroSection.jsx';
import TodaySection from '../components/TodaySection.jsx';
import RiskSection from '../components/RiskSection.jsx';
import SimulationPanel from '../components/SimulationPanel.jsx';
import InboxSection from '../components/InboxSection.jsx';
import '../css/Dashboard.css';

// The home workspace: one continuous page that tells the story top to bottom.
export default function Dashboard() {
  const { status, data, error, reload } = useWorkspace();
  const { hash } = useLocation();

  useEffect(() => {
    if (!data || !hash) return undefined;
    const t = setTimeout(() => scrollToSection(hash.slice(1)), 120); // e.g. /inbox redirects to /#inbox
    return () => clearTimeout(t);
  }, [data, hash]);

  if (status === 'loading' && !data) {
    return <section className="page home"><div className="ws-section" id="overview"><HeroSection /></div><StateMessage kind="loading" message="Loading your workspace…" /></section>;
  }
  if (status === 'error') {
    return <section className="page home"><div className="ws-section" id="overview"><HeroSection /></div><StateMessage kind="error" message={`Couldn't load your workspace. ${error.message}`} onRetry={reload} /></section>;
  }

  const { dashboard, planner, orders } = data;
  return (
    <section className="page home">
      <Reveal as="section" id="overview" className="ws-section"><HeroSection stats={dashboard.stats} /></Reveal>
      <Reveal as="section" id="today" className="ws-section">
        {dashboard.stats.total === 0
          ? <StateMessage message="No orders yet. Add your first order, or draft one from a customer message in the inbox below." />
          : <TodaySection dashboard={dashboard} planner={planner} orders={orders} />}
      </Reveal>
      <Reveal as="section" id="deadlines" className="ws-section"><RiskSection planner={planner} orders={orders} /></Reveal>
      <Reveal as="section" id="simulation" className="ws-section"><SimulationPanel planner={planner} orders={orders} onApplied={reload} /></Reveal>
      <Reveal as="section" id="inbox" className="ws-section"><InboxSection orders={orders} onChanged={reload} /></Reveal>
    </section>
  );
}
