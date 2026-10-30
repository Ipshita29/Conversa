import { useEffect, useRef, useState } from 'react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';

// The deadline transformation. A thin timeline shows where an order's deadline and its predicted finish sit. When a simulation result
// arrives, the original deadline marker fades back while a new marker travels along the timeline to the proposed deadline, changing
// colour with what the scheduler said: blue when it works, amber when the buffer is thin, coral when it is still late.
//
// Everything animated here is DRIVEN BY the real simulation result passed in `view`: the times are the scheduler's, the tone is the
// scheduler's risk classification. Three.js only draws; the labels are ordinary HTML (so they stay selectable and readable) and are
// moved to follow the markers. With reduced motion the stage jumps straight to the result; without WebGL the markers are plain dots.
//
// view = {
//   now: ISO | null,
//   orig:  { deadline, finish, tone } | null,      the schedule today ('late' | 'warn' | 'ok')
//   draft: ISO | null,                              a proposed deadline not yet simulated (shown as a ghost marker)
//   sim:   { deadline, finish, tone } | null,       the simulated result ('late' | 'warn' | 'ok' | 'resolved')
//   runKey: number                                  bumps on every new simulation, so repeated runs replay
// }
const COLORS = { late: [0.851, 0.467, 0.42], warn: [0.878, 0.635, 0.29], ok: [0.141, 0.247, 0.451], resolved: [0.141, 0.247, 0.451], fin: [0.36, 0.41, 0.5], muted: [0.8, 0.77, 0.73], ghost: [0.37, 0.51, 0.78], caramel: [0.773, 0.541, 0.322] };
const css = (c) => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, k) => a + (b - a) * k;
const ms = (iso) => (iso ? Date.parse(iso) : null);

export default function DeadlineStage({ view, tz, fmt, ariaLabel }) {
  const host = useRef(null); const ctl = useRef(null); const lbl = useRef({}); const ticks = useRef([]);
  const reduced = usePrefersReducedMotion();
  const [webgl, setWebgl] = useState(true);
  const viewRef = useRef(view); viewRef.current = view;

  useEffect(() => {
    let gone = false; let dispose = () => {};
    (async () => {
      const THREE = await import('three');
      if (gone || !host.current) return;
      const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true'); canvas.className = 'ds-canvas';
      let renderer = null;
      try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true }); } catch { setWebgl(false); }
      if (renderer) { host.current.prepend(canvas); renderer.setClearColor(0x000000, 0); }
      const scene = new THREE.Scene(); const cam = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
      const disposables = [];
      const setC = (col, c) => col.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace); // the palette is written in sRGB, so say so
      const mat = (color, opacity = 1) => { const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }); disposables.push(m); return m; };
      const geo = (g) => { disposables.push(g); return g; };
      const glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); disposables.push(t); return t; })();

      // ---- scene objects (all positions in pixels; y up)
      const track = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 2)), mat(0xd9d4ca)); scene.add(track);
      const band = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1)), mat(0x243f73, 0)); scene.add(band);
      const tickLines = []; for (let i = 0; i < 12; i += 1) { const t = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1)), mat(0xe4dfd6)); t.visible = false; scene.add(t); tickLines.push(t); }
      const makeMarker = () => {
        const g = new THREE.Group();
        const stem = new THREE.Mesh(geo(new THREE.PlaneGeometry(2, 1)), mat(0x243f73)); const head = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1)), mat(0x243f73)); head.rotation.z = Math.PI / 4;
        const halo = new THREE.Mesh(geo(new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({ map: glowTex, color: 0x243f73, transparent: true, opacity: 0, depthWrite: false })); disposables.push(halo.material);
        g.add(halo, stem, head); scene.add(g); return { g, stem, head, halo };
      };
      const M = { orig: makeMarker(), next: makeMarker(), fin: makeMarker() };

      // ---- the model: what the stage currently shows (tweened) and the particle bursts
      const S = {
        d0: Date.now() - 3600000, d1: Date.now() + 864e5, now: null,
        orig: { t: 0, a: 0, c: [...COLORS.ok], y: 0, g: 0 }, next: { t: 0, a: 0, c: [...COLORS.ghost], y: 0, g: 0 }, fin: { t: 0, a: 0, c: [...COLORS.fin], y: 0, g: 0 },
        band: { t0: 0, t1: 0, a: 0, c: [...COLORS.ok] },
      };
      const tweens = []; const bursts = []; let W = 1; let H = 1; let raf = 0; let lastRun = -1; let showing = null;
      const tween = (obj, to, dur, delay = 0) => { // to: { key: value | [r,g,b] }
        const from = {}; for (const k of Object.keys(to)) from[k] = Array.isArray(obj[k]) ? [...obj[k]] : obj[k];
        if (!dur || reduced) { for (const [k, v] of Object.entries(to)) obj[k] = Array.isArray(v) ? [...v] : v; return; }
        tweens.push({ obj, from, to, dur, t0: performance.now() + delay, ease: ease });
        kick();
      };
      const trackY = () => H * 0.5;
      const xOf = (t) => 24 + ((t - S.d0) / (S.d1 - S.d0)) * (W - 48);

      function domainFor(v) {
        const ts = [ms(v.now), ms(v.orig?.deadline), ms(v.orig?.finish), ms(v.draft), ms(v.sim?.deadline), ms(v.sim?.finish)].filter((x) => x != null);
        if (!ts.length) return [Date.now(), Date.now() + 864e5];
        const lo = Math.min(...ts); const hi = Math.max(...ts); const span = Math.max(hi - lo, 6 * 3600000);
        return [lo - span * 0.14, lo + span * 1.14]; // a little room on both sides so labels near the ends are never cut off
      }

      function sync(v, runChanged) {
        const [a, b] = domainFor(v);
        tween(S, { d0: a, d1: b }, 500);
        S.now = ms(v.now);
        const o = v.orig; const s = v.sim;
        if (!s) { // before a simulation (or after Reset): today's schedule, plus a ghost of the proposal
          showing = 'idle';
          if (o) { S.orig.t = ms(o.deadline) ?? S.orig.t; tween(S.orig, { a: 1, c: COLORS[o.tone] ?? COLORS.late, g: 0.0 }, 450); } else tween(S.orig, { a: 0 }, 250);
          if (o?.finish) { S.fin.t = ms(o.finish); tween(S.fin, { a: 1, c: COLORS.fin }, 450); } else tween(S.fin, { a: 0 }, 250);
          if (v.draft) { if (S.next.a < 0.05) S.next.t = ms(v.draft); tween(S.next, { t: ms(v.draft), a: 0.55, c: COLORS.ghost, y: 0, g: 0 }, 450); } else tween(S.next, { a: 0 }, 250);
          const late = o?.finish && o?.deadline && ms(o.finish) > ms(o.deadline);
          tween(S.band, { t0: ms(o?.finish ?? o?.deadline) ?? 0, t1: ms(o?.deadline) ?? 0, a: o?.finish && o?.deadline ? 0.22 : 0, c: late ? COLORS.late : COLORS.ok }, 450);
          return;
        }
        const final = COLORS[s.tone] ?? COLORS.ok;
        const sd = ms(s.deadline); const sf = ms(s.finish);
        if (runChanged || showing !== 'sim') {
          showing = 'sim';
          if (o) tween(S.orig, { a: 0.24, c: COLORS.muted }, 600); else tween(S.orig, { a: 0 }, 300);
          const startT = o ? ms(o.deadline) : (S.now ?? sd);
          Object.assign(S.next, { t: startT, a: 1, c: [...(o ? COLORS[o.tone] ?? COLORS.late : COLORS.ghost)], y: 0 });
          tween(S.next, { t: sd, c: final }, 1300); // the new marker travels along the timeline to the proposed deadline and takes the result's colour
          // a gentle arc: rise, then settle
          if (!reduced) { tween(S.next, { y: 26 }, 650); tween(S.next, { y: 0 }, 650, 650); }
          if (sf != null) tween(S.fin, { t: sf, a: 1, c: COLORS.fin }, 1300); else tween(S.fin, { a: 0 }, 300);
          const lateAfter = sf != null && sd != null && sf > sd;
          tween(S.band, { t0: sf ?? sd, t1: sd, a: sf != null ? 0.26 : 0, c: lateAfter ? COLORS.late : (s.tone === 'warn' ? COLORS.warn : COLORS.ok) }, 1300);
          if (!reduced) setTimeout(() => { if (!gone) { tween(S.next, { g: 1 }, 380); tween(S.next, { g: 0 }, 900, 380); if (s.tone === 'resolved' || s.tone === 'ok') burst(sd, final, 30); else if (s.tone === 'warn') burst(sd, COLORS.warn, 12); } }, 1300);
        } else { // same run, e.g. a resize: just show the result
          Object.assign(S.next, { t: sd, a: 1, c: [...final] }); if (sf != null) Object.assign(S.fin, { t: sf, a: 1 });
          Object.assign(S.band, { t0: sf ?? sd, t1: sd });
        }
      }

      function burst(t, color, n) {
        if (!renderer) return;
        const pos = new Float32Array(n * 3); const vel = [];
        const x = xOf(t); const y = trackY();
        for (let i = 0; i < n; i += 1) { const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4; const sp = 22 + Math.random() * 34; pos[i * 3] = x; pos[i * 3 + 1] = y + 6; vel.push([Math.cos(ang) * sp, Math.sin(ang) * sp]); }
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const m = new THREE.PointsMaterial({ color: setC(new THREE.Color(), color), map: glowTex, size: 9, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false });
        const p = new THREE.Points(g, m); scene.add(p); bursts.push({ p, g, m, vel, t0: performance.now(), n });
        kick();
      }

      function resize() {
        const r = host.current.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height);
        if (renderer) { renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(W, H, false); }
        cam.left = 0; cam.right = W; cam.bottom = 0; cam.top = H; cam.updateProjectionMatrix();
        kick();
      }

      function frame(now) {
        raf = 0; let busy = false;
        for (let i = tweens.length - 1; i >= 0; i -= 1) {
          const w = tweens[i]; const k = Math.min(1, Math.max(0, (now - w.t0) / w.dur));
          if (now < w.t0) { busy = true; continue; }
          for (const [key, to] of Object.entries(w.to)) {
            if (Array.isArray(to)) w.obj[key] = to.map((v, j) => lerp(w.from[key][j], v, w.ease(k))); else w.obj[key] = lerp(w.from[key], to, w.ease(k));
          }
          if (k >= 1) tweens.splice(i, 1); else busy = true;
        }
        for (let i = bursts.length - 1; i >= 0; i -= 1) {
          const b = bursts[i]; const age = (now - b.t0) / 1100;
          if (age >= 1) { scene.remove(b.p); b.g.dispose(); b.m.dispose(); bursts.splice(i, 1); continue; }
          const a = b.g.attributes.position; for (let j = 0; j < b.n; j += 1) { a.array[j * 3] += b.vel[j][0] * 0.016; a.array[j * 3 + 1] += b.vel[j][1] * 0.016; b.vel[j][0] *= 0.97; b.vel[j][1] *= 0.97; }
          a.needsUpdate = true; b.m.opacity = 0.85 * (1 - age); busy = true;
        }
        draw(); if (busy && !gone) raf = requestAnimationFrame(frame);
      }
      const kick = () => { if (!raf && !gone) raf = requestAnimationFrame(frame); };

      function draw() {
        const y = trackY();
        track.scale.x = W - 32; track.position.set(W / 2, y, 0);
        // day ticks
        const dayMs = 864e5; const first = Math.ceil(S.d0 / dayMs) * dayMs; let n = 0;
        const step = Math.max(1, Math.ceil((S.d1 - S.d0) / dayMs / 7));
        for (let t = first; t < S.d1 && n < 12; t += dayMs * step, n += 1) {
          const x = xOf(t); const tl = tickLines[n]; tl.visible = true; tl.scale.set(1, 9, 1); tl.position.set(x, y, 0);
          const el = ticks.current[n]; if (el) { el.style.transform = `translateX(calc(${x}px - 50%))`; el.style.opacity = '1'; el.textContent = new Date(t).toLocaleDateString(undefined, { timeZone: tz, weekday: 'short', day: 'numeric' }); }
        }
        for (let i = n; i < 12; i += 1) { tickLines[i].visible = false; if (ticks.current[i]) ticks.current[i].style.opacity = '0'; }
        // band between predicted finish and deadline (coral when late, blue when there is room)
        const x0 = xOf(Math.min(S.band.t0, S.band.t1)); const x1 = xOf(Math.max(S.band.t0, S.band.t1));
        band.position.set((x0 + x1) / 2, y, -1); band.scale.set(Math.max(1, x1 - x0), 12, 1); setC(band.material.color, S.band.c); band.material.opacity = S.band.a;
        const place = (key, m, label, up) => {
          const o = S[key]; const x = xOf(o.t); const h = 34;
          m.g.position.set(x, y + o.y, 0); m.g.visible = o.a > 0.01;
          m.stem.scale.set(1, h, 1); m.stem.position.set(0, up ? h / 2 : -h / 2, 0); m.head.scale.set(11, 11, 1); m.head.position.set(0, up ? h + 2 : -h - 2, 0);
          m.halo.scale.set(54, 54, 1); m.halo.position.set(0, up ? h + 2 : -h - 2, -0.5);
          for (const part of [m.stem, m.head]) { setC(part.material.color, o.c); part.material.opacity = o.a; }
          setC(m.halo.material.color, o.c); m.halo.material.opacity = (o.g || 0) * 0.5 + (key === 'next' ? 0.06 * o.a : 0);
          const el = lbl.current[key]; const rival = key === 'orig' ? S.next : key === 'next' ? S.orig : null;
          const lift = rival && rival.a > 0.05 && o.a < rival.a ? -34 : 0; // the fainter of the two deadline labels steps up a row so they never sit on each other
          if (el) { el.style.transform = up ? `translate(calc(${x}px - 50%), calc(${-(h + 18) - o.y + lift}px - 100%))` : `translate(calc(${x}px - 50%), ${h + 18}px)`; el.style.opacity = String(Math.min(1, o.a * 1.2)); el.style.setProperty('--c', css(o.c)); }
          const dot = lbl.current[`${key}Dot`]; if (dot) { dot.style.transform = `translate(calc(${x}px - 50%), ${(up ? -1 : 1) * (h + 2) - o.y}px) rotate(45deg)`; dot.style.opacity = String(o.a); dot.style.background = css(o.c); }
        };
        place('orig', M.orig, null, true); place('next', M.next, null, true); place('fin', M.fin, null, false);
        const nowEl = lbl.current.now; if (nowEl) { nowEl.style.opacity = S.now ? '1' : '0'; if (S.now) nowEl.style.transform = `translateX(calc(${xOf(S.now)}px - 50%))`; }
        if (renderer) renderer.render(scene, cam);
      }

      const ro = new ResizeObserver(() => resize()); ro.observe(host.current); resize();
      ctl.current = { sync, resize };
      sync(viewRef.current, true); lastRun = viewRef.current.runKey;
      draw();
      dispose = () => {
        gone = true; cancelAnimationFrame(raf); ro.disconnect(); tweens.length = 0;
        bursts.forEach((b) => { b.g.dispose(); b.m.dispose(); }); disposables.forEach((d) => d.dispose());
        if (renderer) { renderer.dispose(); renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); }
        ctl.current = null; void lastRun;
      };
    })().catch(() => setWebgl(false));
    return () => { gone = true; dispose(); };
  }, [reduced, tz]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whenever the real result (or the draft) changes, hand it to the stage. A new runKey replays the transformation.
  const prevRun = useRef(view.runKey);
  useEffect(() => {
    const changed = prevRun.current !== view.runKey; prevRun.current = view.runKey;
    ctl.current?.sync(view, changed);
  }, [view.orig?.deadline, view.orig?.finish, view.orig?.tone, view.draft, view.sim?.deadline, view.sim?.finish, view.sim?.tone, view.runKey, view.now]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (el) => { lbl.current[k] = el; };
  return (
    <div className="ds" ref={host} role="img" aria-label={ariaLabel}>
      <span className="ds-now" ref={set('now')}>Now</span>
      {Array.from({ length: 12 }, (_, i) => <span key={i} className="ds-tick" ref={(el) => { ticks.current[i] = el; }} />)}
      {!webgl && ['orig', 'next', 'fin'].map((k) => <i key={k} className="ds-dot" ref={set(`${k}Dot`)} />)}
      {view.orig && <span className="ds-lbl is-orig" ref={set('orig')}><small>{view.sim ? 'Was' : 'Original deadline'}</small><b>{fmt(view.orig.deadline)}</b></span>}
      {(view.sim || view.draft) && <span className="ds-lbl is-next" ref={set('next')}><small>{view.sim ? 'New deadline' : 'Proposed'}</small><b>{fmt(view.sim?.deadline ?? view.draft)}</b></span>}
      <span className="ds-lbl is-fin" ref={set('fin')}><small>Predicted finish</small><b>{fmt(view.sim?.finish ?? view.orig?.finish)}</b></span>
    </div>
  );
}
