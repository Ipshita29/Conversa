import { useEffect, useRef, useState } from 'react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';

// The three headline amounts of a payment (order total, confirmed paid, remaining balance).
// The numbers are ordinary HTML text that counts up from the real backend values; a small, transparent Three.js canvas lays soft blue and
// caramel particles and a light sweep over the figure that is changing. The canvas never holds information: if WebGL is missing or the
// visitor prefers reduced motion, the numbers simply appear. Screen readers always get the final value, not the counting.

const RUPEES = (n, decimals) => `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n)}`;
const decimalsOf = (n) => (Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 && Math.round(n * 100) % 100 !== 0 ? 2 : 0);
const ease = (t) => 1 - (1 - t) ** 3;
const COUNT_MS = 950;
const TINTS = { total: '#6F95CF', paid: '#3F66B0', left: '#C58A52' }; // soft blue, navy-blue, caramel

// ---- the Three.js layer ----------------------------------------------------------------------------------------------------
// Pixel-space orthographic scene over the figures row. It only renders while something is animating.
async function createFx(host) {
  const THREE = await import('three');
  // Each scene gets a brand-new canvas: a canvas whose WebGL context was lost can never be reused, so one is never handed over.
  const canvas = document.createElement('canvas'); canvas.className = 'pm-fx'; canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true }); } catch { return null; } // no WebGL: numbers still animate
  host.appendChild(canvas);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  const live = new Set();       // { object, update(t) -> bool (still alive) }
  const disposables = [];
  let raf = 0; let w = 1; let h = 1; let dead = false;

  const dot = document.createElement('canvas'); dot.width = dot.height = 64;
  { const g = dot.getContext('2d'); const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.45, 'rgba(255,255,255,0.55)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); }
  const dotTex = new THREE.CanvasTexture(dot); disposables.push(dotTex);
  const band = document.createElement('canvas'); band.width = 256; band.height = 8;
  { const g = band.getContext('2d'); const r = g.createLinearGradient(0, 0, 256, 0); r.addColorStop(0, 'rgba(255,255,255,0)'); r.addColorStop(0.5, 'rgba(255,255,255,1)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 256, 8); }
  const bandTex = new THREE.CanvasTexture(band); disposables.push(bandTex);

  function resize() {
    const r = host.getBoundingClientRect(); w = Math.max(1, r.width); h = Math.max(1, r.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(w, h, false);
    camera.left = 0; camera.right = w; camera.top = h; camera.bottom = 0; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(host); resize();

  function frame(now) {
    raf = 0;
    for (const e of [...live]) if (!e.update(now)) { scene.remove(e.object); e.object.geometry?.dispose(); e.object.material?.dispose(); live.delete(e); }
    renderer.render(scene, camera);
    if (live.size && !dead) raf = requestAnimationFrame(frame); else renderer.clear();
  }
  const kick = () => { if (!raf && !dead) raf = requestAnimationFrame(frame); };
  // y is measured from the top of the host in CSS pixels; the scene's y axis points up.
  const at = (rect) => ({ x: rect.left + rect.width / 2, y: h - (rect.top + rect.height / 2), rw: rect.width, rh: rect.height });

  return {
    // A short puff of soft particles rising from a number.
    burst(rect, color, count = 26) {
      const { x, y, rw } = at(rect);
      const pos = new Float32Array(count * 3); const vel = [];
      for (let i = 0; i < count; i++) {
        pos[i * 3] = x + (Math.random() - 0.5) * rw * 0.8; pos[i * 3 + 1] = y + (Math.random() - 0.5) * 14;
        vel.push({ vx: (Math.random() - 0.5) * 26, vy: 18 + Math.random() * 40 });
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ color, map: dotTex, size: 11, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false });
      const obj = new THREE.Points(geo, mat); scene.add(obj);
      const t0 = performance.now(); let last = t0;
      live.add({ object: obj, update(now2) {
        const k = (now2 - t0) / 1100; if (k >= 1) return false;
        const dt = Math.min(0.05, (now2 - last) / 1000); last = now2;
        const a = geo.attributes.position;
        for (let i = 0; i < count; i++) { a.array[i * 3] += vel[i].vx * dt; a.array[i * 3 + 1] += vel[i].vy * dt; vel[i].vy *= 0.985; }
        a.needsUpdate = true; mat.opacity = 0.8 * (1 - ease(k)); return true;
      } }); kick();
    },
    // A soft band of light that crosses a card once.
    sweep(rect, color) {
      const { x, y, rw, rh } = at(rect);
      const mat = new THREE.MeshBasicMaterial({ color, map: bandTex, transparent: true, opacity: 0.0, depthWrite: false });
      const obj = new THREE.Mesh(new THREE.PlaneGeometry(rw * 0.55, rh), mat); obj.position.set(x - rw * 0.6, y, 0); scene.add(obj);
      const t0 = performance.now();
      live.add({ object: obj, update(now2) {
        const k = (now2 - t0) / 1000; if (k >= 1) return false;
        obj.position.x = x - rw * 0.6 + rw * 1.2 * ease(k); mat.opacity = 0.26 * Math.sin(Math.PI * k); return true;
      } }); kick();
    },
    resize,
    dispose() {
      dead = true; cancelAnimationFrame(raf); ro.disconnect();
      for (const e of live) { scene.remove(e.object); e.object.geometry?.dispose(); e.object.material?.dispose(); }
      live.clear(); disposables.forEach((d) => d.dispose()); renderer.dispose();
      renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext(); // hand the GPU context back now, not at garbage collection
      canvas.remove();
    },
  };
}

// ---- the component --------------------------------------------------------------------------------------------------------
// figures: [{ key: 'total' | 'paid' | 'left', label, value (number | null) }]. `settleKey` replays a short settle (used after a rejection).
export default function AmountFigures({ figures, settleKey = 0 }) {
  const reduced = usePrefersReducedMotion();
  const host = useRef(null); const numEls = useRef({});
  const fx = useRef(null);
  const [shown, setShown] = useState(() => Object.fromEntries(figures.map((f) => [f.key, 0])));
  const cur = useRef(Object.fromEntries(figures.map((f) => [f.key, 0]))); // what is on screen right now
  const goal = useRef({});                                                  // the last real value each figure was sent to
  const tweens = useRef({}); const raf = useRef(0);
  const settle = useRef(settleKey);

  // Three.js is loaded on demand and torn down with the component. Counting starts once it is ready (or has failed, or 1.5 s have
  // passed), so the numbers and the particles always begin together and loading Three.js never swallows the start of the count.
  const [ready, setReady] = useState(reduced);
  useEffect(() => {
    if (reduced) { setReady(true); return undefined; }
    let gone = false;
    const limit = setTimeout(() => { if (!gone) setReady(true); }, 1500);
    createFx(host.current).then((f) => { if (gone) { f?.dispose(); return; } fx.current = f; setReady(true); }).catch(() => { if (!gone) setReady(true); });
    return () => { gone = true; clearTimeout(limit); fx.current?.dispose(); fx.current = null; };
  }, [reduced]);

  useEffect(() => () => { cancelAnimationFrame(raf.current); raf.current = 0; }, []);

  function run() {
    if (raf.current) return;
    const step = (now) => {
      raf.current = 0; let again = false;
      for (const [key, t] of Object.entries(tweens.current)) {
        if (t.t0 === null) t.t0 = now; // the clock starts on the first painted frame, so a busy moment (loading Three.js) never eats the animation
        const k = Math.max(0, Math.min(1, (now - t.t0) / COUNT_MS));
        cur.current[key] = t.from + (t.to - t.from) * ease(k);
        if (k < 1) again = true; else { cur.current[key] = t.to; delete tweens.current[key]; }
      }
      setShown({ ...cur.current });
      if (again) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }
  const play = (key, from, to, delay = 0) => {
    const el = numEls.current[key]; const hostRect = host.current?.getBoundingClientRect();
    if (reduced || !el) { cur.current[key] = to; setShown((s) => ({ ...s, [key]: to })); return; }
    setTimeout(() => {
      tweens.current[key] = { from, to, t0: null }; run();
      if (fx.current && hostRect) {
        const r = el.getBoundingClientRect(); const rel = { left: r.left - hostRect.left, top: r.top - hostRect.top, width: r.width, height: r.height };
        const card = el.closest('.pm-fig')?.getBoundingClientRect();
        if (to > 0) fx.current.burst(rel, TINTS[key] ?? '#6F95CF');
        if (card) fx.current.sweep({ left: card.left - hostRect.left, top: card.top - hostRect.top, width: card.width, height: card.height }, TINTS[key] ?? '#6F95CF');
      }
    }, delay);
  };

  // Whenever a real value differs from what the figure was last sent to, count from where it is now to the new value.
  const values = figures.map((f) => f.value);
  useEffect(() => {
    if (!ready) return;
    figures.forEach((f, i) => {
      if (typeof f.value !== 'number') { goal.current[f.key] = null; cur.current[f.key] = 0; return; }
      if (goal.current[f.key] === f.value) return;
      const first = goal.current[f.key] === undefined;
      goal.current[f.key] = f.value;
      play(f.key, cur.current[f.key], f.value, first ? i * 130 : 0);
    });
  }, [ready, ...values]); // eslint-disable-line react-hooks/exhaustive-deps

  // A rejection changes no amount, but the figures re-settle onto the confirmed values so the owner sees them confirmed again.
  useEffect(() => {
    if (!ready || settle.current === settleKey) return;
    settle.current = settleKey;
    figures.forEach((f, i) => { if (typeof f.value === 'number' && f.value > 0) play(f.key, f.value * 0.55, f.value, i * 90); });
  }, [settleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pm-figures" ref={host}>
      {figures.map((f) => (
        <div key={f.key} className={`pm-fig is-${f.key}`}>
          <span className="pm-fig-label">{f.label}</span>
          {typeof f.value === 'number' ? (
            <>
              <b className="pm-fig-num" aria-hidden="true" ref={(el) => { numEls.current[f.key] = el; }}>{RUPEES(shown[f.key] ?? 0, decimalsOf(f.value))}</b>
              <span className="sr-only">{RUPEES(f.value, decimalsOf(f.value))}</span>
            </>
          ) : <b className="pm-fig-num is-none" ref={(el) => { numEls.current[f.key] = el; }}>Not priced</b>}
        </div>
      ))}
    </div>
  );
}
