import { ArrowDown } from 'lucide-react';
import { greeting } from '../utils/format.js';
import { scrollToSection } from '../utils/scroll.js';
import DemoBadge from './DemoBadge.jsx';

export default function HeroSection({ stats }) {
  const now = new Date();
  const open = stats ? stats.pending + stats.inProgress : null;
  return (
    <div className="hero">
      <div className="hero-copy" data-scroll-speed="0.14" data-fade>
      <div className="hero-meta">
        <p className="eyebrow">Business operations, made clear</p>
        <DemoBadge />
      </div>
      <p className="hero-greeting">{greeting(now)} · {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h1>Your business, in better rhythm.</h1>
      <p className="hero-lede">Every order, every deadline, every conversation — thoughtfully brought together in one place.</p>
      <div className="hero-actions">
        <button type="button" className="btn btn-primary" onClick={() => scrollToSection('today')}>Review today's orders <ArrowDown size={16} aria-hidden="true" /></button>
        {stats && <p className="hero-summary">{stats.total} orders · {open} open · {stats.atRisk} {stats.atRisk === 1 ? 'needs' : 'need'} a closer look</p>}
      </div>
      <p className="hero-statement"><span>The AI reads.</span> <span>Rules decide.</span> <span>You approve.</span></p>
      </div>
      <span className="hero-orb" aria-hidden="true" data-scroll-speed="-0.22"><i /></span>
    </div>
  );
}
