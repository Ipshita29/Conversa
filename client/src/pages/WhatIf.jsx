import { useLocation } from 'react-router-dom';
import { WhatIfPage } from '../components/Workspace.jsx';

// What if? runs on the two seeded commitment-scenario orders (real demo records, planned by the real scheduler). A simulation never saves anything. Other pages
// can open it on one order (state.prefill) to start on Move a deadline.
export default function WhatIf() {
  const { state } = useLocation();
  return <section className="page whatif"><WhatIfPage scope="commitment" prefill={state?.prefill ?? null} /></section>;
}
