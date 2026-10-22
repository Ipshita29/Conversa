import { Link } from 'react-router-dom';
import { AlarmClock, ArrowRight, Inbox } from 'lucide-react';
import { getConversations } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import SectionHead from './SectionHead.jsx';

const EL_TONE = { deadline_passed: 'high', unschedulable: 'high', late: 'high', tight: 'medium', needs_details: 'info', on_track: 'low' };
const plural = (n, one, many) => (n === 1 ? one : many);

// Two doors into the dedicated pages, each with a live count. The inbox count is fetched separately and never blocks the overview.
export default function ExploreCards({ planner }) {
  const conv = useAsync(getConversations);
  const moves = planner.nextMoves ?? [];
  const risky = moves.filter((m) => ['deadline_passed', 'unschedulable', 'late', 'tight'].includes(m.kind)).length;
  const blocked = moves.filter((m) => m.kind === 'needs_details').length;
  const msgs = conv.data?.items.flatMap((c) => c.messages) ?? [];
  const unread = msgs.filter((m) => !m.read).length;
  const latest = conv.data?.items.flatMap((c) => c.messages.map((m) => ({ ...m, who: c.customerName }))).sort((x, y) => new Date(y.at) - new Date(x.at)).slice(0, 2) ?? [];
  return (
    <>
      <SectionHead eyebrow="Explore" title="Go deeper.">Two dedicated workspaces for the details.</SectionHead>
      <div className="explore">
        <Link to="/deadlines" className="explore-card explore-deadlines">
          <div className="explore-top"><span className="explore-icon"><AlarmClock size={19} aria-hidden="true" /></span><span className="explore-kicker">Planner</span></div>
          <h3>Deadlines</h3>
          <p>{Array.isArray(planner.nextMoves) ? `${risky} ${plural(risky, 'order', 'orders')} at risk · ${blocked} waiting on details` : 'Your production timeline and risks'}</p>
          {moves.length > 0 && (
            <ol className="explore-line explore-preview" aria-hidden="true">
              {moves.slice(0, 6).map((m) => <li key={m.orderId} className={`el-${EL_TONE[m.kind] ?? 'low'}`}><i>{m.rank}</i></li>)}
            </ol>
          )}
          <span className="explore-go">Open the timeline <ArrowRight size={15} aria-hidden="true" /></span>
        </Link>
        <Link to="/inbox" className="explore-card explore-inbox">
          <div className="explore-top"><span className="explore-icon"><Inbox size={19} aria-hidden="true" /></span><span className="explore-kicker">Messages</span></div>
          <h3>Inbox</h3>
          <p>{conv.status === 'ready' ? `${unread} unread of ${msgs.length} ${plural(msgs.length, 'message', 'messages')}` : conv.status === 'error' ? 'Open your messages' : 'Checking messages…'}</p>
          {latest.length > 0 && (
            <ul className="explore-msgs explore-preview" aria-hidden="true">
              {latest.map((m) => <li key={m.id ?? m.at} className={m.read ? '' : 'is-unread'}><b>{m.who}</b><span>{m.text}</span></li>)}
            </ul>
          )}
          <span className="explore-go">Open the inbox <ArrowRight size={15} aria-hidden="true" /></span>
        </Link>
      </div>
    </>
  );
}
