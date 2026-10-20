const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Scrolls to a section by id (smooth unless the user prefers reduced motion) and records it in the URL hash.
export function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  window.history.replaceState(window.history.state, '', `#${id}`);
  return true;
}
