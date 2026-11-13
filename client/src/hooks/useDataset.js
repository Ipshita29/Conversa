import { useEffect, useState } from 'react';
import { DEMO_MODE, listOrders } from '../services/api.js';

// Which data set a page shows: 'real' (the business's own conversations, orders and payments) or 'demo' (the sample bakery). They are never mixed on a
// page. The choice is remembered; until it is made, real data wins as soon as any exists, otherwise the demo. In the browser-only demo there is just
// the demo, so nothing is asked of the server and `dataset` is undefined (the mock backend ignores it).
const KEY = 'conversa.dataset';
const read = () => { try { const v = localStorage.getItem(KEY); return v === 'real' || v === 'demo' ? v : null; } catch { return null; } };

export default function useDataset() {
  const [chosen, setChosen] = useState(read);
  const [counts, setCounts] = useState(DEMO_MODE ? { real: 0, demo: 0 } : null);
  useEffect(() => {
    if (DEMO_MODE) return undefined;
    let off = false;
    Promise.all([listOrders({ dataset: 'real', pageSize: 1 }), listOrders({ dataset: 'demo', pageSize: 1 })])
      .then(([r, d]) => !off && setCounts({ real: r.total, demo: d.total }))
      .catch(() => !off && setCounts({ real: 0, demo: 0 }));
    return () => { off = true; };
  }, []);
  const both = Boolean(counts && counts.real > 0 && counts.demo > 0);
  const effective = DEMO_MODE ? undefined : !counts ? undefined : (both ? chosen : null) ?? (counts.real > 0 ? 'real' : counts.demo > 0 ? 'demo' : 'real');
  const choose = (v) => { setChosen(v); try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };
  return { dataset: effective, ready: DEMO_MODE || counts !== null, both, counts, choose };
}
