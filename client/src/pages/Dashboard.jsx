import { lazy, Suspense, useRef } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import useWorkspace from '../hooks/useWorkspace.js';
import { HeroSection, Reveal, ScrollR, useCardGlow } from '../components/Effects.jsx';
import { StateMessage } from '../components/UI.jsx';
import { ConnectSection, DayWorkspace } from '../components/Insights.jsx';
import { summarise } from '../utils/homeSummary.js';
import useHashScroll from '../hooks/useHashScroll.js';
import '../css/Dashboard.css';

// The Three.js field is large: it loads after the first paint and never blocks the page.
const Field = lazy(() => import('../components/Field.jsx'));

// Old bookmarks like /#inbox or /#deadlines now live on their own pages.
const MOVED = { inbox: '/inbox', deadlines: '/plan', next: '/plan', simulation: '/whatif' };

// What the Smart Promise Engine looks at before a deadline is accepted. Each card opens the part of the app where it lives.
const CHECKS = [
  { label: 'Prep time', value: 'Counted', caption: 'The time the work really takes', to: '/orders' },
  { label: 'Capacity', value: 'Checked', caption: 'What is already on the plan', to: '/plan' },
  { label: 'Payment', value: 'Considered', caption: 'Confirmation and payment status', to: '/orders' },
  { label: 'Deadline', value: 'Realistic', caption: 'The earliest date you can keep', to: '/whatif' },
];

const plural = (n, one, many) => (n === 1 ? one : many);

function Glow() { return <span className="fx-glow" aria-hidden="true" />; }

const Connect = () => (
  <>
    <Reveal as="section" id="connect" className="fx-section fx-connect"><ConnectSection /></Reveal>
    <ScrollR target="connect" />
  </>
);

// The landing page: the hero, how a promise is made, how the work is planned, then today's live workspace.
export default function Dashboard() {
  const { status, data, error, reload } = useWorkspace();
  const { hash } = useLocation();
  const pageRef = useRef(null);
  useHashScroll(Boolean(data));
  useCardGlow(pageRef);
  const moved = MOVED[hash.slice(1)];
  if (moved) return <Navigate to={moved} replace />;

  const sum = data ? summarise({ planner: data.planner, orders: data.orders }) : null;
  const live = sum ? `${sum.open.length} open ${plural(sum.open.length, 'order', 'orders')} · ${sum.attention} ${plural(sum.attention, 'needs', 'need')} attention` : 'Checked before you commit';

  return (
    <section className="page home" ref={pageRef}>
      <Suspense fallback={null}><Field /></Suspense>

      <div id="overview" className="home-hero"><HeroSection stats={data?.dashboard.stats} attention={sum?.attention} /></div>

      {/* 01 · Smart Promise Engine */}
      <Reveal as="section" id="product" className="fx-section fx-reveal">
        <div className="fx-bento">
          <article className="fx-card fx-feature" style={{ '--i': 0 }}>
            <Glow />
            <p className="chip chip--flat"><i aria-hidden="true" />01 · Smart Promise Engine</p>
            <h2 className="fx-h"><span className="fx-sans">Promise what</span><em className="fx-serif is-caramel">you can keep.</em></h2>
            <p className="fx-lead">Before you accept an order, Conversa calculates a realistic delivery commitment from preparation time, capacity and payment status.</p>
            <span className="fx-spacer" />
            <p className="fx-micro">{live}</p>
          </article>
          {CHECKS.map(({ label, value, caption, to }, i) => (
            <Link key={label} to={to} className="fx-card fx-metric" style={{ '--i': i + 1 }} aria-label={`${label}: ${value}. ${caption}`}>
              <Glow />
              <div className="fx-metric-top"><span className="chip chip--flat chip--sm">{label}</span><span className="fx-micro" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span></div>
              <div className="fx-metric-bottom"><span className="fx-value">{value}</span><span className="fx-body">{caption}</span></div>
            </Link>
          ))}
        </div>
      </Reveal>

      {/* 02 · Production planning: the field gathers into a heart behind this scene; today's live workspace sits over it */}
      <Reveal as="section" id="planning" className="fx-section fx-assembly fx-reveal">
        <p className="chip"><i aria-hidden="true" />02 · Production planning</p>
        <div id="today" className="fx-panel fx-day-card">
          {status === 'error' ? <StateMessage kind="error" message={`Couldn't load your workspace. ${error.message}`} onRetry={reload} />
            : data ? <DayWorkspace planner={data.planner} orders={data.orders} />
            : <StateMessage kind="loading" message="Loading your workspace…" />}
        </div>
      </Reveal>

      <Connect />
    </section>
  );
}
