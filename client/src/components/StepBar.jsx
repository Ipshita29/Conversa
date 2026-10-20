import { STATUS_LABEL } from '../utils/format.js';

const STEPS = ['pending', 'confirmed', 'in_progress', 'completed'];

// Four quiet dots showing how far an order has progressed (from its real status).
export default function StepBar({ status }) {
  if (status === 'cancelled') return <span className="muted step-cancelled">Cancelled</span>;
  const at = STEPS.indexOf(status);
  return (
    <ol className="stepbar" aria-label={`Progress: ${STATUS_LABEL[status] ?? status}`}>
      {STEPS.map((s, i) => <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''} title={STATUS_LABEL[s]} />)}
    </ol>
  );
}
