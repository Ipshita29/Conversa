import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { formatInTz, formatMinutes, isDemoOrder, timeLeft } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';
import StateMessage from './StateMessage.jsx';
import { RiskBadge } from './Badge.jsx';

// The few orders the dashboard endpoint flags as urgent (late, tight, or due within 48 hours). The full timeline lives on /deadlines.
export default function UrgentOrders({ dashboard, planner, orders }) {
  const tz = planner.range.timezone;
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  const urgent = dashboard.urgentOrders.slice(0, 3);
  return (
    <>
      <SectionHead eyebrow="Urgent" title="What needs you first.">The few orders closest to trouble. The full production timeline is one click away.</SectionHead>
      {urgent.length === 0 ? <StateMessage message="Nothing urgent right now." /> : (
        <ul className="urgent-list">
          {urgent.map((u) => (
            <li key={u.id}>
              <div><strong>{u.customerName}</strong>{isDemoOrder(byId[u.id]) && <span className="demo-tag">Demo</span>}<p>{u.item}{byId[u.id]?.quantity > 1 ? ` × ${byId[u.id].quantity}` : ''}</p></div>
              <div className="urgent-when"><span>Due {formatInTz(u.deadline, tz)}</span><small className="muted">{timeLeft(u.deadline)} · {u.prepTimeMinutes === null ? 'prep not set' : `${formatMinutes(u.prepTimeMinutes)} prep`}</small></div>
              <RiskBadge risk={u.risk} />
            </li>
          ))}
        </ul>
      )}
      <Link className="btn btn-primary urgent-cta" to="/deadlines">See the full timeline <ArrowRight size={15} aria-hidden="true" /></Link>
    </>
  );
}
