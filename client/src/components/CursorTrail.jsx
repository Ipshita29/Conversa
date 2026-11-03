import { useEffect, useRef } from 'react';
import { motionValue, animate } from 'framer-motion';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import '../css/CursorTrail.css';

// A cursor trail: a soft line the pointer appears to draw across the whole page, in Conversa's pastel blue, muted navy and a touch of
// caramel. It follows the real pointer through a spring (so it trails naturally rather than sticking), fades out shortly after the pointer stops, and
// sits BEHIND the content: the canvas ignores the pointer completely, so clicks, scrolling and text selection are untouched.
//   - Pointer events feed two Framer Motion values; nothing here touches React state, so moving the mouse never re-renders anything.
//   - One canvas, drawn only while there is something to draw; the animation frame and every listener are cleaned up on unmount.
//   - Off for touch and pen input, off where there is no hover, and off when the visitor prefers reduced motion (the children render exactly the same).
const LIFE = 1400; // ms a point of the line stays visible
const MAX_POINTS = 110;
const MIN_STEP = 3; // px: a new point is only added after the line has moved this far
const COLOURS = { glow: 'rgba(126, 170, 232, 0.8)', line: 'rgba(36, 63, 115, 0.85)', accent: 'rgba(197, 138, 82, 0.9)' };

export default function CursorTrail({ children, className = '' }) {
  const canvas = useRef(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const host = window; const cv = canvas.current;
    if (reduced || !cv || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return undefined;
    const ctx = cv.getContext('2d'); if (!ctx) return undefined;
    const x = motionValue(0); const y = motionValue(0);
    const points = []; // { x, y, t }
    let raf = 0; let size = { w: 0, h: 0 }; let seeded = false; let inside = false; let stops = [];

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size = { w: window.innerWidth, h: window.innerHeight };
      cv.width = Math.round(size.w * dpr); cv.height = Math.round(size.h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    window.addEventListener('resize', fit); fit();

    const draw = (now) => {
      raf = 0;
      while (points.length && now - points[0].t > LIFE) points.shift();
      ctx.clearRect(0, 0, size.w, size.h);
      if (points.length > 1) {
        const pass = (width, colour, blur, fadeBy) => {
          ctx.lineWidth = width; ctx.shadowBlur = blur; ctx.shadowColor = colour; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          // a smooth curve through the midpoints of neighbouring points, one short segment at a time so each can fade on its own
          for (let i = 1; i < points.length - 1; i += 1) {
            const a = points[i - 1]; const b = points[i]; const c = points[i + 1];
            const life = 1 - (now - b.t) / LIFE; if (life <= 0) continue;
            const k = i / points.length; // the head (newest) is strongest and thickest
            ctx.globalAlpha = Math.min(1, life * life * 1.15) * fadeBy; ctx.strokeStyle = colour;
            ctx.lineWidth = width * (0.35 + 0.65 * k);
            ctx.beginPath(); ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2); ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2); ctx.stroke();
          }
        };
        pass(16, COLOURS.glow, 22, 0.75); // the soft, slightly blurred body
        pass(3.6, COLOURS.line, 0, 1); // the thin navy line on top
        pass(1.8, COLOURS.accent, 0, 1); // a hairline of caramel
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      }
      if (points.length) raf = requestAnimationFrame(draw);
    };
    const wake = () => { if (!raf) raf = requestAnimationFrame(draw); };

    const add = () => {
      const p = points[points.length - 1]; const nx = x.get(); const ny = y.get();
      if (p && Math.hypot(nx - p.x, ny - p.y) < MIN_STEP) return;
      points.push({ x: nx, y: ny, t: performance.now() }); if (points.length > MAX_POINTS) points.shift();
      wake();
    };
    stops = [x.on('change', add), y.on('change', add)];

    const follow = (px, py) => {
      const to = { type: 'spring', stiffness: 170, damping: 26, mass: 0.6 }; // gentle: the line lags the pointer a little and eases in
      animate(x, px, to); animate(y, py, to);
    };
    const move = (e) => {
      if (e.pointerType !== 'mouse') return;
      const px = e.clientX; const py = e.clientY;
      if (!seeded || !inside) { x.jump(px); y.jump(py); seeded = true; inside = true; points.length = 0; return; } // start a new line where the pointer enters, not from the last place it left
      follow(px, py);
    };
    const leave = () => { inside = false; };
    host.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave, { passive: true });
    return () => {
      host.removeEventListener('pointermove', move); document.documentElement.removeEventListener('pointerleave', leave); window.removeEventListener('resize', fit);
      stops.forEach((s) => s()); x.stop?.(); y.stop?.(); cancelAnimationFrame(raf);
    };
  }, [reduced]);

  return (
    <div className={`ct ${className}`.trim()}>
      <canvas className="ct-canvas" ref={canvas} aria-hidden="true" />
      {children}
    </div>
  );
}
