import { formatDate, formatMinutes } from '../utils/format.js';
import SectionHead from './SectionHead.jsx';

export default function CapacitySection({ planner }) {
  const w = planner.workload;
  const pct = w.utilisationPercent;
  return (
    <>
      <SectionHead eyebrow="Capacity" title="Time you have, time you've promised.">
        Pending preparation against your working hours for the next {planner.range.days} days.
      </SectionHead>
      <p className="capacity-figure"><strong>{formatMinutes(w.pendingMinutes)}</strong> of work · <strong>{formatMinutes(w.availableMinutes)}</strong> available <span className="muted">({pct}%)</span></p>
      <div className="meter" role="progressbar" aria-valuenow={Math.min(pct, 100)} aria-valuemin="0" aria-valuemax="100" aria-label="Share of available time already promised"><div className={pct > 100 ? 'meter-fill over' : 'meter-fill'} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
      <ul className="day-bars">
        {planner.days.map((d) => {
          const full = d.capacityMinutes > 0 && d.plannedMinutes >= d.capacityMinutes;
          return (
            <li key={d.date}>
              <span className="day-name">{formatDate(d.date)}</span>
              <div className="meter"><div className={full ? 'meter-fill over' : 'meter-fill'} style={{ width: d.capacityMinutes ? `${Math.min(100, (d.plannedMinutes / d.capacityMinutes) * 100)}%` : '0%' }} /></div>
              <span className="day-fig">{d.capacityMinutes === 0 ? 'Day off' : `${formatMinutes(d.plannedMinutes)} / ${formatMinutes(d.capacityMinutes)}`}{full && <b> · Fully booked</b>}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
