import { useEffect, useRef } from 'react';
import { onChange } from '../services/live.js';

// Calls `fn` (usually a page's reload) when the server reports a change in one of `topics`, at most once every 400 ms.
export default function useLive(topics, fn) {
  const ref = useRef(fn); ref.current = fn;
  const key = topics.join(',');
  useEffect(() => {
    let t = null;
    const off = onChange(topics, () => { if (t) return; t = setTimeout(() => { t = null; ref.current(); }, 400); });
    return () => { off(); clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
