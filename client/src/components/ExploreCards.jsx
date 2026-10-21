import { Link } from 'react-router-dom';
import { AlarmClock, ArrowRight, Inbox } from 'lucide-react';
import { getConversations } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import SectionHead from './SectionHead.jsx';

const plural = (n, one, many) => (n === 1 ? one : many);

// Two doors into the dedicated pages, each with a live count. The inbox count is fetched separately and never blocks the overview.
export default function ExploreCards({ planner }) {
  const conv = useAsync(getConversations);
  const moves = planner.nextMoves ?? [];
  const risky = moves.filter((m) => ['deadline_passed', 'unschedulable', 'late', 'tight'].includes(m.kind)).length;
  const blocked = moves.filter((m) => m.kind === 'needs_details').length;
  const msgs = conv.data?.items.flatMap((c) => c.messages) ?? [];
  const unread = msgs.filter((m) => !m.read).length;
  return (
    <>
      <SectionHead eyebrow="Explore" title="Go deeper.">Two dedicated workspaces for the details.</SectionHead>
      <div className="explore">
        <Link to="/deadlines" className="explore-card">
          <AlarmClock size={22} aria-hidden="true" />
          <h3>Deadlines</h3>
          <p>{Array.isArray(planner.nextMoves) ? `${risky} ${plural(risky, 'order', 'orders')} at risk · ${blocked} waiting on details` : 'Your production timeline and risks'}</p>
          <span className="explore-go">Open the timeline <ArrowRight size={15} aria-hidden="true" /></span>
        </Link>
        <Link to="/inbox" className="explore-card">
          <Inbox size={22} aria-hidden="true" />
          <h3>Inbox</h3>
          <p>{conv.status === 'ready' ? `${unread} unread of ${msgs.length} ${plural(msgs.length, 'message', 'messages')}` : conv.status === 'error' ? 'Open your messages' : 'Checking messages…'}</p>
          <span className="explore-go">Open the inbox <ArrowRight size={15} aria-hidden="true" /></span>
        </Link>
      </div>
    </>
  );
}
