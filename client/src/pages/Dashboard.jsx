import { Navigate, useLocation } from 'react-router-dom';
import useWorkspace from '../hooks/useWorkspace.js';
import Reveal from '../components/Reveal.jsx';
import StateMessage from '../components/StateMessage.jsx';
import HeroSection from '../components/HeroSection.jsx';
import TodaySection from '../components/TodaySection.jsx';
import PriorityCarousel from '../components/PriorityCarousel.jsx';
import ExploreCards from '../components/ExploreCards.jsx';
import useHashScroll from '../hooks/useHashScroll.js';
import '../css/Dashboard.css';

// Old bookmarks like /#inbox or /#deadlines now live on their own pages.
const MOVED = { inbox: '/inbox', deadlines: '/deadlines', next: '/deadlines', simulation: '/deadlines#simulation' };

// The home page is an overview: the hero, today's numbers, the priority carousel, and doors to Deadlines and Inbox.
export default function Dashboard() {
  const { status, data, error, reload } = useWorkspace();
  const { hash } = useLocation();
  useHashScroll(Boolean(data));
  const moved = MOVED[hash.slice(1)];
  if (moved) return <Navigate to={moved} replace />;

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
          ? <StateMessage message="No orders yet. Add your first order, or draft one from a customer message in the Inbox." />
          : <TodaySection dashboard={dashboard} planner={planner} orders={orders} />}
      </Reveal>
      {dashboard.stats.total > 0 && <Reveal as="section" id="urgent" className="ws-section"><PriorityCarousel planner={planner} orders={orders} /></Reveal>}
      <Reveal as="section" id="explore" className="ws-section"><ExploreCards planner={planner} /></Reveal>
    </section>
  );
}
