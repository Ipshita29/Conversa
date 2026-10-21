import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { scrollToSection } from '../utils/scroll.js';

// Scrolls to the section named by the URL hash (e.g. /deadlines#simulation) once the page's data has rendered,
// and again whenever the hash changes while the page is already open.
export default function useHashScroll(ready) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return undefined;
    const t = setTimeout(() => scrollToSection(hash.slice(1)), 100);
    return () => clearTimeout(t);
  }, [ready, hash]);
}
