import { useLocation, useSearchParams } from 'react-router-dom';
import { WhatIfPage } from '../components/Workspace.jsx';

// What if? opens on the prepared demonstration: Aanya Sharma and Kartik Singh both want delivery at 10:30, planned by the real scheduler from fixed sample orders,
// so the result is the same every time (Kartik 9:00-9:30, then Aanya 9:30-10:30). It runs on copies and never touches the business's own orders; Apply to Plan
// is the owner's explicit step. `?scenario=orders` opens "Move a deadline and see who it affects" on the business's actual open orders instead.
export default function WhatIf() {
  const { state } = useLocation();
  const [params] = useSearchParams();
  const scope = params.get('scenario') === 'orders' ? 'all' : 'commitment';
  return <section className="page whatif"><WhatIfPage key={scope} scope={scope} prefill={state?.prefill ?? null} /></section>;
}
