import { useLocation } from 'react-router-dom';
import useWorkspace from '../hooks/useWorkspace.js';
import { StateMessage } from '../components/UI.jsx';
import { WhatIfWorkspace } from '../components/Insights.jsx';
import '../css/Whatif.css';
import '../css/WhatIfPage.css';

// A simulation never saves anything: the scheduler runs on a copy. Saving is a separate, explicit confirmation inside the workspace.
export default function WhatIf() {
  const { status, data, error, reload } = useWorkspace();
  const { state } = useLocation();
  const head = <header className="wf-head"><div><p className="eyebrow">What-if</p><h1>What happens if things change?</h1><p className="wf-sub">Test a decision. See its impact across every order before you commit.</p></div></header>;
  if (status === 'loading' && !data) return <section className="page whatif">{head}<StateMessage kind="loading" message="Loading the schedule…" /></section>;
  if (status === 'error') return <section className="page whatif">{head}<StateMessage kind="error" message={`Couldn't load the schedule. ${error.message}`} onRetry={reload} /></section>;
  const { planner, orders } = data;
  if (orders.length === 0) return <section className="page whatif">{head}<StateMessage message="Add an order first, then you can test changes to the schedule." /></section>;
  return <section className="page whatif"><WhatIfWorkspace planner={planner} orders={orders} onApplied={reload} prefill={state?.prefill ?? null} /></section>;
}
