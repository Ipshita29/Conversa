import { useEffect, useRef, useState } from 'react';
import { scrollToSection } from '../utils/scroll.js';

// The signature letter from the headline, carried down the page as a scroll guide. Once the hero has scrolled away a serif "R" docks
// to the edge of the screen; its leg is a line that fills as the reader nears the "Bring your conversations together" section,
// and the whole thing is a link that glides there. It reads the native scroll position (Lenis moves the real window scroll), so it
// works the same with smooth scrolling off, never intercepts wheel or touch scrolling, and only ever animates opacity/transform.
export default function ScrollR({ target = 'connect', label = 'Bring your conversations together' }) {
  const [shown, setShown] = useState(false);
  const fill = useRef(null);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const end = document.getElementById(target);
      if (!end) return;
      const vh = window.innerHeight;
      const y = window.scrollY;
      const dest = end.getBoundingClientRect().top + y; // page position of the section we point at
      const from = vh * 0.5;
      const p = Math.min(1, Math.max(0, (y - from) / Math.max(1, dest - vh * 0.6 - from)));
      fill.current?.style.setProperty('--p', p.toFixed(3));
      setShown(y > from && end.getBoundingClientRect().top > vh * 0.55); // visible between the hero and the section it points to
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null; // content loads late and moves the target
    ro?.observe(document.body);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); ro?.disconnect(); };
  }, [target]);

  return (
    <a href={`#${target}`} className={`scroll-r${shown ? ' is-shown' : ''}`} aria-label={`Continue to: ${label}`} tabIndex={shown ? 0 : -1} aria-hidden={shown ? undefined : 'true'}
      onClick={(e) => { e.preventDefault(); scrollToSection(target); }}>
      <span className="scroll-r-glyph" aria-hidden="true">R</span>
      <span className="scroll-r-leg" ref={fill} aria-hidden="true"><i /></span>
      <span className="scroll-r-label" aria-hidden="true">Next</span>
    </a>
  );
}
