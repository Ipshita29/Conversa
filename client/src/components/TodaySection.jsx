import { dateKey, formatInTz, formatMinutes, isDemoOrder, OPEN } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';
import StateMessage from './StateMessage.jsx';
import StepBar from './StepBar.jsx';
import { RiskBadge, StatusBadge } from './Badge.jsx';

// "Today" = orders scheduled for today by the engine, or with a deadline today (business timezone).
export default function TodaySection({ dashboard, planner, orders, eyebrow = 'Today', title = 'Your day, at a glance.', subtitle = 'A quick read on where the work stands.' }) {
  const tz = planner.range.timezone;
  const today = planner.days[0]?.date;
  const scheduled = new Set((planner.days[0]?.orders ?? []).map((o) => o.id));
  const needsDetails = new Set(planner.unscheduledOrders.map((u) => u.id));
  const todays = orders
    .filter((o) => scheduled.has(o.id) || (o.deadline && dateKey(o.deadline, tz) === today))
    .sort((a, b) => (a.deadline ? new Date(a.deadline) : Infinity) - (b.deadline ? new Date(b.deadline) : Infinity));
  const { stats } = dashboard;
  const attention = stats.atRisk + planner.unscheduledOrders.length;

  return (
    <>
      <SectionHead eyebrow={eyebrow} title={title}>{subtitle}</SectionHead>
      <dl className="metrics">
        <div className="metric metric-key"><dt>Today's orders</dt><dd>{todays.length}</dd><small>due or scheduled today</small></div>
        <div className="metric"><dt>In progress</dt><dd>{stats.inProgress}</dd><small>being prepared</small></div>
        <div className="metric"><dt>Completed</dt><dd>{stats.completed}</dd><small>all completed orders</small></div>
        <div className="metric"><dt>Need attention</dt><dd>{attention}</dd><small>at risk or missing details</small></div>
      </dl>

      <h3 className="list-title">Today's work</h3>
      {todays.length === 0 ? (
        <StateMessage message="Nothing is due or scheduled today." />
      ) : (
        <ul className="work-list">
          {todays.map((o) => {
            const nd = OPEN.includes(o.status) && needsDetails.has(o.id);
            return (
              <li key={o.id} className="work-row">
                <div className="work-main">
                  <strong>{o.customerName}{isDemoOrder(o) && <span className="demo-tag">Demo</span>}</strong>
                  <span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span>
                </div>
                <div className="work-when">
                  <span>{o.deadline ? `Due ${formatInTz(o.deadline, tz)}` : 'No deadline'}</span>
                  <small className="muted">{o.prepTimeMinutes === null ? 'Prep time not set' : `${formatMinutes(o.prepTimeMinutes)} prep`}</small>
                </div>
                <div className="work-progress"><StepBar status={o.status} /><StatusBadge status={o.status} /></div>
                <div className="work-risk">{(OPEN.includes(o.status) || nd) && <RiskBadge risk={o.risk} needsDetails={nd} />}</div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
