import { Navigate, useLocation } from 'react-router-dom';
import useWorkspace from '../hooks/useWorkspace.js';
import { HeroSection, Reveal, ScrollR } from '../components/Effects.jsx';
import { StateMessage } from '../components/UI.jsx';
import { ConnectSection, DayWorkspace } from '../components/Insights.jsx';
import { summarise } from '../utils/homeSummary.js';
import useHashScroll from '../hooks/useHashScroll.js';
import '../css/Dashboard.css';

// Old bookmarks like /#inbox or /#deadlines now live on their own pages.
const MOVED = { inbox: '/inbox', deadlines: '/plan', next: '/plan', simulation: '/whatif' };

const Connect = () => (
  <>
    <Reveal as="section" id="connect" className="ws-section"><ConnectSection /></Reveal>
    <ScrollR target="connect" />
  </>
);

// The landing page: the hero, then today's workspace (three numbers, what needs attention, today's plan).
export default function Dashboard() {
  const { status, data, error, reload } = useWorkspace();
  const { hash } = useLocation();
  useHashScroll(Boolean(data));
  const moved = MOVED[hash.slice(1)];
  if (moved) return <Navigate to={moved} replace />;

  if (status === 'loading' && !data) {
    return <section className="page home"><div className="ws-section" id="overview"><HeroSection /></div><StateMessage kind="loading" message="Loading your workspace…" /><Connect /></section>;
  }
  if (status === 'error') {
    return <section className="page home"><div className="ws-section" id="overview"><HeroSection /></div><StateMessage kind="error" message={`Couldn't load your workspace. ${error.message}`} onRetry={reload} /><Connect /></section>;
  }

  const { dashboard, planner, orders } = data;
  return (
    <section className="page home">
      <Reveal as="section" id="overview" className="ws-section"><HeroSection stats={dashboard.stats} attention={summarise({ planner, orders }).attention} /></Reveal>
      <Reveal as="section" id="today" className="ws-section"><DayWorkspace planner={planner} orders={orders} /></Reveal>
      <Connect />
    </section>
  );
}
