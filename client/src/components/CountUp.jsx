import { useEffect, useRef, useState } from 'react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';

// Counts up to a whole number the first time it scrolls into view (about a second). With reduced motion, or
// when the value is not a positive whole number, the real value is shown immediately.
export default function CountUp({ value, duration = 900 }) {
  const ref = useRef(null);
  const reduced = usePrefersReducedMotion();
  const animate = !reduced && Number.isInteger(value) && value > 0 && typeof IntersectionObserver !== 'undefined';
  const [shown, setShown] = useState(animate ? 0 : value);
  const done = useRef(false);

  useEffect(() => {
    if (!animate) { setShown(value); return undefined; }
    if (done.current) { setShown(value); return undefined; }
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect(); done.current = true;
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / duration);
        setShown(Math.round(value * (1 - (1 - p) ** 3))); // ease-out
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, { threshold: 0.6 });
    io.observe(ref.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value, animate, duration]);

  return <span ref={ref}>{shown}</span>;
}
