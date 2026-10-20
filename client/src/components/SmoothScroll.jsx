import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ReactLenis, useLenis } from 'lenis/react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import { registerLenis, scrollToTop } from '../utils/scroll.js';
import { updateParallax, clearParallax } from '../utils/parallax.js';

// Exposes the Lenis instance to scrollToSection(), resets to the top on new pages,
// and publishes the smoothed scroll progress + parallax on every frame.
function Bridge() {
  const setProgress = (p) => document.documentElement.style.setProperty('--scroll-progress', (Number.isFinite(p) ? p : 0).toFixed(4));
  const lenis = useLenis(({ progress, limit }) => {
    setProgress(limit > 0 ? progress : 0);
    updateParallax();
  });
  const { pathname, hash } = useLocation();
  useEffect(() => { registerLenis(lenis); return () => registerLenis(null); }, [lenis]);
  useEffect(() => { if (!hash) scrollToTop(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  // Content arrives asynchronously and changes the page height without a scroll event: re-measure and re-publish.
  useEffect(() => {
    if (!lenis || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { lenis.resize(); setProgress(lenis.limit > 0 ? lenis.progress : 0); updateParallax(); });
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [lenis]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { clearParallax(); document.documentElement.style.removeProperty('--scroll-progress'); }, []);
  return null;
}

// Lenis drives the page scroll (the root/window). It is not mounted at all when the user prefers reduced motion,
// so those users keep native, instant scrolling and no scroll-linked animation. Children are never remounted
// when that preference changes.
export default function SmoothScroll({ children }) {
  const reduced = usePrefersReducedMotion();
  return (
    <>
      {!reduced && <ReactLenis root options={{ lerp: 0.075, smoothWheel: true, anchors: false }}><Bridge /></ReactLenis>}
      {!reduced && <div className="scroll-progress" aria-hidden="true" />}
      {children}
    </>
  );
}
