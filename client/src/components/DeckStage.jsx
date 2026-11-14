import { useEffect, useRef } from 'react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';
import '../css/DeckStage.css';

// "The deck": a Three.js scene that plays over the proposed production sequence when a simulation result arrives. A small layered deck (decorative backs plus ONE card
// per real order) forms, is shuffled, and then the order cards are dealt one by one along curved paths to the exact positions of the real cards, flipping over as they land.
// The scene only carries the motion: blank pastel faces, no text. When a card lands it dissolves into the real HTML card underneath (the existing React component, with all
// the order information and interactions), which `onLanded(count)` reveals. The scene is lazy-loaded, renders only while it plays, and disposes everything afterwards.
//   play   a number: each change plays the animation once (0 = never). `count` is how many real cards will be dealt.
const FRONT_BORDER = '#D7E4F5';
const T = { form: 700, shuffleAt: 750, shuffle: 1000, dealAt: 2000, flight: 780, gap: 290, fadeBack: 450 }; // milliseconds
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2); // in-out cubic
const easeOut = (t) => 1 - (1 - t) ** 3;
const smooth = (a, b, t) => { const x = clamp((t - a) / (b - a)); return x * x * (3 - 2 * x); };
const seeded = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }; // the same "random" jitter every time: no per-run surprises

export default function DeckStage({ play = 0, count = 0, onLanded, onDone, children }) {
  const wrap = useRef(null);
  const reduced = usePrefersReducedMotion();
  const cb = useRef({}); cb.current = { onLanded, onDone }; // latest callbacks, without restarting the scene

  useEffect(() => {
    if (!play) return undefined;
    const done = () => { cb.current.onLanded?.(Infinity); cb.current.onDone?.(); };
    if (reduced || count < 1) { done(); return undefined; }
    let stopped = false; let raf = 0; let cleanup = () => {};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      let THREE;
      try { THREE = await import('three'); } catch { done(); return; }
      await wait(680); // the result panel is still sliding in: let it settle so the real cards are where they will stay
      if (stopped || !wrap.current) return;
      // a fresh canvas for every play: a canvas whose WebGL context was released cannot be given a new one, so a replay would silently fall back
      const root = wrap.current; const cvs = document.createElement('canvas'); cvs.className = 'wxd-canvas'; cvs.setAttribute('aria-hidden', 'true'); root.appendChild(cvs);
      const cardEls = [...root.querySelectorAll('.wxc-card')];
      if (cardEls.length === 0) { cvs.remove(); done(); return; }
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas: cvs, alpha: true, antialias: true, powerPreference: 'low-power' }); } catch { cvs.remove(); done(); return; }

      const PAD = 70; // the canvas reaches past the stage so shadows and flying cards are not clipped
      const W = root.clientWidth + PAD * 2; const H = root.clientHeight + PAD * 2;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(W, H, false);
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      const fov = 28; const camera = new THREE.PerspectiveCamera(fov, W / H, 10, 4000);
      camera.position.set(0, 0, (H / 2) / Math.tan((fov * Math.PI) / 360)); // 1 world unit = 1 css pixel on the z = 0 plane
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0xd9cfbf, 1.05));
      const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(-260, 420, 700); sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 7; sun.shadow.bias = -0.0004;
      const sh = Math.max(W, H) * 0.75; Object.assign(sun.shadow.camera, { left: -sh, right: sh, top: sh, bottom: -sh, near: 50, far: 2200 });
      scene.add(sun);
      const table = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.6, H * 1.6), new THREE.ShadowMaterial({ opacity: 0.2 })); table.position.z = -8; table.receiveShadow = true; scene.add(table);

      const first = cardEls[0].getBoundingClientRect(); const cw = first.width; const ch = first.height;
      const radius = Math.min(22, cw / 6); const thick = 3.2;
      const rounded = (w, h, r) => { const s = new THREE.Shape(); const x = -w / 2; const y = -h / 2;
        s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s; };
      const geoms = []; const mats = []; const texs = [];
      const track = (o, list) => { list.push(o); return o; };
      const outer = rounded(cw, ch, radius); const inner = rounded(cw - 3, ch - 3, Math.max(2, radius - 1.5));
      const gEdge = track(new THREE.ExtrudeGeometry(outer, { depth: thick, bevelEnabled: false, curveSegments: 10 }), geoms); gEdge.translate(0, 0, -thick / 2);
      const gBorder = track(new THREE.ShapeGeometry(outer, 10), geoms); const gInner = track(new THREE.ShapeGeometry(inner, 10), geoms);
      // the card back: a navy field with a fine cream lattice and a single diamond. No suits, no values, no text.
      const bc = document.createElement('canvas'); bc.width = 256; bc.height = Math.round(256 * (ch / cw));
      { const g = bc.getContext('2d'); const w = bc.width; const h = bc.height; g.fillStyle = '#243F73'; g.fillRect(0, 0, w, h);
        g.strokeStyle = 'rgba(238,230,214,0.22)'; g.lineWidth = 1; for (let i = -h; i < w + h; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke(); g.beginPath(); g.moveTo(i + h, 0); g.lineTo(i, h); g.stroke(); }
        g.strokeStyle = 'rgba(238,230,214,0.85)'; g.lineWidth = 2; g.strokeRect(14, 14, w - 28, h - 28);
        g.fillStyle = '#243F73'; g.fillRect(w / 2 - 34, h / 2 - 46, 68, 92); g.strokeStyle = 'rgba(224,146,95,0.95)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(w / 2, h / 2 - 40); g.lineTo(w / 2 + 28, h / 2); g.lineTo(w / 2, h / 2 + 40); g.lineTo(w / 2 - 28, h / 2); g.closePath(); g.stroke(); }
      const backTex = track(new THREE.CanvasTexture(bc), texs); backTex.colorSpace = THREE.SRGBColorSpace; backTex.anisotropy = 4;
      backTex.repeat.set(1 / cw, 1 / ch); backTex.offset.set(0.5, 0.5);
      const faceColor = new THREE.Color(getComputedStyle(cardEls[0]).backgroundColor);
      // every card has its own materials, so each can fade on its own; the geometries and the back texture are shared
      const makeCard = () => {
        const mk = (m) => { m.transparent = true; return track(m, mats); };
        const mEdge = mk(new THREE.MeshStandardMaterial({ color: 0xe9e1d2, roughness: 0.8 }));
        const mBorder = mk(new THREE.MeshStandardMaterial({ color: new THREE.Color(FRONT_BORDER), roughness: 0.55 }));
        const mFront = mk(new THREE.MeshStandardMaterial({ color: faceColor, emissive: faceColor, emissiveIntensity: 0.45, roughness: 0.55 }));
        const mBack = mk(new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.5 }));
        const g = new THREE.Group(); g.userData.mats = [mEdge, mBorder, mFront, mBack];
        const edge = new THREE.Mesh(gEdge, mEdge); edge.castShadow = true;
        const border = new THREE.Mesh(gBorder, mBorder); border.position.z = thick / 2 + 0.05;
        const face = new THREE.Mesh(gInner, mFront); face.position.z = thick / 2 + 0.12;
        const back = new THREE.Mesh(gBorder, mBack); back.position.z = -thick / 2 - 0.05; back.rotation.y = Math.PI;
        g.add(edge, border, face, back); scene.add(g); return g;
      };

      const rootRect = root.getBoundingClientRect();
      const slotOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - rootRect.left + r.width / 2 - W / 2 + PAD, y: -(r.top - rootRect.top + r.height / 2 - H / 2 + PAD), s: r.width / cw, sy: r.height / ch }; };
      // the deck sits on the stage's horizontal centre, high enough that a tall (phone) stage still shows it near the top
      const deckX = 0; const deckY = Math.max(0, H / 2 - PAD - ch * 1.0); const DS = 0.82; const TILT = -1.02;
      const extras = Math.min(7, 13 - count); const M = count + Math.max(2, extras);
      const layers = Array.from({ length: M }, (_, i) => ({ i, g: makeCard(), actual: i >= M - count ? M - 1 - i : -1 })); // the top `count` layers are the real orders, order 1 on top
      const base = (i) => ({ x: deckX + (seeded(i + 1) - 0.5) * 4, y: deckY + i * 1.5, z: i * 0.9, rz: (seeded(i + 9) - 0.5) * 0.16 });
      const pose = (l, p, o = {}) => { l.g.position.set(p.x, p.y, p.z); l.g.rotation.set(o.rx ?? TILT, o.ry ?? Math.PI, o.rz ?? p.rz ?? 0); l.g.scale.setScalar(o.s ?? DS); };
      const setOpacity = (l, v) => { l.g.visible = v > 0.01; for (const m of l.g.userData.mats) m.opacity = v; };
      const landed = new Set(); let slots = null; const faded = {};
      let ticking = false;

      const frame = (now) => {
        if (stopped) return;
        const t = now - start;
        // 1. the deck forms: backs drop onto the pile one after another
        // 2. a gentle riffle shuffle; 3. the order cards are dealt from the top; 4. the spare backs slip away
        const u = clamp((t - T.shuffleAt) / T.shuffle);
        for (const l of layers) {
          const b = base(l.i); const born = clamp((t - l.i * 38) / T.form * 1.4);
          if (l.dealtAt === undefined && l.actual >= 0 && t >= T.dealAt + l.actual * T.gap) l.dealtAt = T.dealAt + l.actual * T.gap;
          if (l.actual >= 0 && l.dealtAt !== undefined) continue; // dealt cards are handled below
          let x = b.x; let y = b.y; let z = b.z; let rz = b.rz;
          const dir = l.i % 2 ? 1 : -1;
          if (u > 0 && u < 1) { // riffle: split into two halves, then interleave back
            const split = ease(clamp(u / 0.38)); const merge = clamp((u - 0.36 - (l.i / M) * 0.3) / 0.3);
            const open = split * (1 - easeOut(merge));
            x += dir * cw * 0.52 * open; y += (l.i % 2) * 7 * open; z += Math.sin(merge * Math.PI) * 26 * split; rz += dir * 0.05 * open;
          }
          const enter = easeOut(born);
          pose(l, { x, y: y + (1 - enter) * 70, z: z + (1 - enter) * 160, rz }, { rz: rz + (1 - enter) * dir * 0.4 });
          let v = enter;
          if (l.actual < 0 && t > T.dealAt + count * T.gap) v = 1 - clamp((t - T.dealAt - count * T.gap) / T.fadeBack); // the spare backs leave once everything is dealt
          setOpacity(l, v); l.g.castShadow = true;
        }
        if (t >= T.dealAt - 40 && !slots) slots = cardEls.map(slotOf);
        for (const l of layers) {
          if (l.actual < 0 || l.dealtAt === undefined) continue;
          const k = l.actual; const p = clamp((t - l.dealtAt) / T.flight);
          const b = base(l.i); const s = slots[k]; const e = ease(p);
          const lift = Math.sin(p * Math.PI);
          const x = b.x + (s.x - b.x) * e; const y = b.y + (s.y - b.y) * e + lift * 50; const z = b.z + (0 - b.z) * e + lift * 80;
          const flip = smooth(0.18, 0.86, p);
          l.g.position.set(x, y, z);
          l.g.rotation.set(TILT * (1 - smooth(0.05, 0.9, p)) + Math.sin(p * Math.PI) * -0.18, Math.PI * (1 - flip), b.rz * (1 - e) + Math.sin(p * Math.PI) * 0.14 * (k % 2 ? 1 : -1));
          l.g.scale.set(DS + (s.s - DS) * e, DS + (s.sy - DS) * e, 1);
          if (p >= 1) {
            if (!landed.has(k)) { landed.add(k); cb.current.onLanded?.(landed.size); faded[k] = t; }
            setOpacity(l, 1 - clamp((t - faded[k]) / 170)); // dissolves into the real card, which is now visible beneath
          }
        }
        renderer.render(scene, camera);
        if (t < T.dealAt + count * T.gap + T.flight + T.fadeBack + 120) raf = requestAnimationFrame(frame);
        else { teardown(); done(); }
      };
      const onResize = () => { if (!stopped) { teardown(); done(); } }; // the layout changed under the animation: show the real cards at once
      window.addEventListener('resize', onResize);
      const teardown = () => {
        if (ticking === 'down') return; ticking = 'down'; cancelAnimationFrame(raf); window.removeEventListener('resize', onResize);
        geoms.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose()); texs.forEach((x) => x.dispose()); table.geometry.dispose(); table.material.dispose();
        renderer.dispose(); renderer.forceContextLoss(); cvs.remove();
      };
      cleanup = teardown;
      cvs.style.display = 'block'; cvs.style.left = `${-PAD}px`; cvs.style.top = `${-PAD}px`; cvs.style.width = `${W}px`; cvs.style.height = `${H}px`;
      const start = performance.now(); raf = requestAnimationFrame(frame);
    })();

    return () => { stopped = true; cancelAnimationFrame(raf); cleanup(); };
  }, [play]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="wxd" ref={wrap}>{children}</div>;
}
