import { useLocation } from 'react-router-dom';
import useWorkspace from '../hooks/useWorkspace.js';
import { StateMessage } from '../components/UI.jsx';
import { WhatIfWorkspace } from '../components/WhatIf.jsx';

// A simulation never saves anything: the scheduler runs on a copy. Saving is a separate, explicit confirmation inside the workspace.
export default function WhatIf() {
  const { status, data, error, reload } = useWorkspace();
  const { state } = useLocation();
  const head = <header className="wf-head"><div><p className="wf-eyebrow">What-if simulator</p><h1>Move a deadline, <em>see what happens.</em></h1><p className="wf-sub">Test a change on a copy of your schedule. Nothing is saved until you apply it.</p></div></header>;
  if (status === 'loading' && !data) return <section className="page whatif"><div className="wf">{head}<StateMessage kind="loading" message="Loading the schedule…" /></div></section>;
  if (status === 'error') return <section className="page whatif"><div className="wf">{head}<StateMessage kind="error" message={`Couldn't load the schedule. ${error.message}`} onRetry={reload} /></div></section>;
  const { planner, orders } = data;
  if (orders.length === 0) return <section className="page whatif"><div className="wf">{head}<StateMessage message="Add an order first, then you can test changes to the schedule." /></div></section>;
  return <section className="page whatif"><WhatIfWorkspace planner={planner} orders={orders} onApplied={reload} prefill={state?.prefill ?? null} /></section>;
}
