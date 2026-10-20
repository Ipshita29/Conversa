import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

// Live value of the user's reduced-motion preference.
export default function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.(QUERY).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return undefined;
    const on = (e) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
