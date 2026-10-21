// Scroll-linked effects, driven by Lenis' (smoothed) scroll position. Called on every Lenis scroll frame;
// never called when Lenis is off (reduced motion), so nothing moves for those users.
//   data-parallax="0.05"  the element drifts by (distance from the viewport centre x speed): zero when centred
//   --hero-p (on <html>)  0..1, how far the hero has scrolled away; CSS turns it into scale / fade / drift
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MAX_SHIFT = 14; // px: a gentle float, never enough to touch the text under a heading

// --hero-p: 0 at the top of the page, 1 once the hero has (almost) scrolled away. CSS turns it into scale/fade/drift.
function updateHero() {
  const hero = document.getElementById('overview');
  if (!hero) return;
  const p = clamp(window.scrollY / (hero.offsetHeight * 0.9), 0, 1);
  document.documentElement.style.setProperty('--hero-p', p.toFixed(3));
}

export function updateParallax() {
  updateHero();
  const vh = window.innerHeight;
  document.querySelectorAll('[data-parallax]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.bottom < -200 || r.top > vh + 200) return; // far off screen: skip

    const prev = el._shift || 0; // the rect already includes our own previous shift: remove it to get the natural position
    const centre = r.top - prev + r.height / 2;
    const shift = clamp(-(centre - vh / 2) * parseFloat(el.dataset.parallax), -MAX_SHIFT, MAX_SHIFT);
    el._shift = shift;
    el.style.transform = `translate3d(0, ${shift.toFixed(1)}px, 0)`;
  });
}

export function clearParallax() {
  document.documentElement.style.removeProperty('--hero-p');
  document.querySelectorAll('[data-parallax]').forEach((el) => { el.style.transform = ''; el._shift = 0; });
}
