import { useEffect, useRef, useState } from 'react';

// Fades/lifts its children in once, when scrolled into view (from="right": the section heading slides in from the right). Shows immediately if IntersectionObserver is unavailable.
export default function Reveal({ as: Tag = 'div', className = '', from, children, ...rest }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (shown || !ref.current) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect(); } }, { threshold: 0.05 });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown]);

  return <Tag ref={ref} className={`reveal${from === 'right' ? ' reveal--right' : ''}${shown ? ' is-visible' : ''} ${className}`.trim()} {...rest}>{children}</Tag>;
}
