// Scroll-linked effects, driven by Lenis' (smoothed) scroll position.
//   data-parallax="0.05"      drifts by (distance from the viewport centre x speed): zero when centred, floats through the screen
//   data-scroll-speed="0.14"  shifts by (scroll position x speed): zero at the top of the page. Positive lags behind the scroll, negative leads
//   data-fade                 opacity falls to ~0.1 as the element scrolls off the top
// Called on every Lenis scroll frame. Never called when Lenis is off (reduced motion), so nothing moves for those users.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MAX_SHIFT = 90; // px: keeps every effect subtle

export function updateParallax() {
  const vh = window.innerHeight;
  document.querySelectorAll('[data-parallax], [data-scroll-speed], [data-fade]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.bottom < -200 || r.top > vh + 200) return; // far off screen: skip

    if (el.dataset.scrollSpeed !== undefined) {
      const shift = clamp(window.scrollY * parseFloat(el.dataset.scrollSpeed), -MAX_SHIFT, MAX_SHIFT);
      el._shift = shift;
      el.style.transform = `translate3d(0, ${shift.toFixed(1)}px, 0)`;
    } else if (el.dataset.parallax !== undefined) {
      const prev = el._shift || 0; // the rect already includes our own previous shift: remove it to get the natural position
      const centre = r.top - prev + r.height / 2;
      const shift = clamp(-(centre - vh / 2) * parseFloat(el.dataset.parallax), -MAX_SHIFT, MAX_SHIFT);
      el._shift = shift;
      el.style.transform = `translate3d(0, ${shift.toFixed(1)}px, 0)`;
    }
    if (el.dataset.fade !== undefined) {
      const natural = r.bottom - (el._shift || 0);
      el.style.opacity = clamp((natural - 40) / (r.height * 0.75), 0.1, 1).toFixed(3);
    }
  });
}

export function clearParallax() {
  document.querySelectorAll('[data-parallax], [data-scroll-speed], [data-fade]').forEach((el) => { el.style.transform = ''; el.style.opacity = ''; el._shift = 0; });
}
