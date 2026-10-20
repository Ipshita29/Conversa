const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// The active Lenis instance (set by <SmoothScroll>), or null when smooth scrolling is off (e.g. reduced motion).
let lenis = null;
export const registerLenis = (instance) => { lenis = instance; };

// Scrolls to a section by id and records it in the URL hash. All in-app scrolling goes through here.
// With Lenis: smooth; Lenis itself honours the element's scroll-margin-top (which clears the sticky mobile bar).
// Without Lenis (reduced motion): an instant native jump.
export function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  const top = id === 'overview'; // the first section means "the very top", not "just below the page padding"
  if (lenis && !reduced()) {
    lenis.resize(); // re-measure first: the page may have grown since Lenis last measured (e.g. data just rendered)
    lenis.scrollTo(top ? 0 : el);
  }
  else if (top) window.scrollTo(0, 0);
  else el.scrollIntoView({ behavior: 'auto', block: 'start' });
  window.history.replaceState(window.history.state, '', `#${id}`);
  return true;
}

// Jump to the very top without animation (used on route changes).
export function scrollToTop() {
  if (lenis) lenis.scrollTo(0, { immediate: true });
  else window.scrollTo(0, 0);
}
