import { useEffect, useRef } from 'react';

// ======== Payment Atelier: the three Three.js scenes ========
// Scene A  CollectionRings : glass rings whose arcs show how much of what is billed has been collected.
// Scene B  ReceiptDesk     : the real payment screenshots, as paper in space; clicking one selects that payment.
// Scene C  Atmosphere      : soft translucent shapes drifting behind the page.
// The canvases are decoration and a second way to pick a receipt: every fact and every action also exists as ordinary HTML, so nothing
// depends on WebGL. This file is lazy-loaded; three.js itself is imported on demand inside the stage.

const NAVY = '#243F73';
const GOLD = '#C58A52';
const AMBER = '#D9A94E';
const MINT = '#B8E3DE';
const PALE = '#E7F0FB';
const ease = (t) => 1 - (1 - t) ** 3;

// One renderer, one loop per stage. `build({ THREE, scene, camera, renderer, host, pointer })` returns { update(t, dt), resize(w, h), dispose() }.
// The loop pauses while the canvas is off screen or the tab is hidden; everything created is disposed on unmount.
function useStage(hostRef, { build, fixed = false, camera: camSpec, pixelRatio = 2, shadows = false, deps = [] }) {
  const buildRef = useRef(build); buildRef.current = build;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let dead = false; let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      if (dead) return;
      const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true'); canvas.className = 'pa-canvas';
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' }); } catch { return; }
      host.appendChild(canvas);
      renderer.setClearColor(0x000000, 0);
      if (shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(camSpec?.fov ?? 35, 1, 0.1, 80);
      camera.position.set(...(camSpec?.position ?? [0, 0, 9]));
      const pointer = { x: 0, y: 0, tx: 0, ty: 0, inside: false, clientX: 0, clientY: 0 };
      const api = buildRef.current({ THREE, scene, camera, renderer, host, canvas, pointer });
      let w = 1; let h = 1;
      const resize = () => {
        const r = host.getBoundingClientRect(); w = Math.max(1, r.width); h = Math.max(1, r.height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatio));
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); api.resize?.(w, h, camera);
      };
      const ro = new ResizeObserver(resize); ro.observe(host); resize();

      const onMove = (e) => { const r = host.getBoundingClientRect(); pointer.clientX = e.clientX - r.left; pointer.clientY = e.clientY - r.top; pointer.tx = fixed ? (e.clientX / innerWidth) * 2 - 1 : ((e.clientX - r.left) / r.width) * 2 - 1; pointer.ty = fixed ? -((e.clientY / innerHeight) * 2 - 1) : -(((e.clientY - r.top) / r.height) * 2 - 1); pointer.inside = fixed || (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom); };
      window.addEventListener('pointermove', onMove, { passive: true });

      let raf = 0; let visible = true; let last = performance.now();
      const frame = (now) => {
        raf = 0;
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 3); pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 3); // eased, never snapping
        api.update(now / 1000, dt);
        renderer.render(scene, camera);
        if (visible && !document.hidden && !dead) raf = requestAnimationFrame(frame);
      };
      const kick = () => { if (!raf && visible && !document.hidden && !dead) { last = performance.now(); raf = requestAnimationFrame(frame); } };
      const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }, { rootMargin: '120px' });
      if (!fixed) io.observe(host);
      document.addEventListener('visibilitychange', kick);
      const lost = (e) => e.preventDefault(); canvas.addEventListener('webglcontextlost', lost);
      kick();

      cleanup = () => {
        cancelAnimationFrame(raf); io.disconnect(); ro.disconnect();
        window.removeEventListener('pointermove', onMove); document.removeEventListener('visibilitychange', kick); canvas.removeEventListener('webglcontextlost', lost);
        api.dispose?.();
        scene.traverse((o) => { o.geometry?.dispose?.(); const m = o.material; if (m) [].concat(m).forEach((x) => { x.map?.dispose?.(); x.dispose?.(); }); });
        renderer.dispose(); renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove();
      };
    })();
    return () => { dead = true; cleanup(); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------------------------------------------------------------------------------------------------------------------
// Scene A: collection rings. received / pending / left are the ledger's own totals; the arcs are their shares of what is billed.
export function CollectionRings({ received, pending, left }) {
  const hostRef = useRef(null);
  const data = useRef({ received, pending, left }); data.current = { received, pending, left };
  useStage(hostRef, {
    camera: { fov: 32, position: [0, 0, 12] },
    deps: [],
    build({ THREE, scene, pointer }) {
      const group = new THREE.Group(); group.rotation.x = -0.35; scene.add(group);
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const key = new THREE.DirectionalLight(0xdfe8ff, 1.5); key.position.set(-4, 5, 6); scene.add(key);
      const warm = new THREE.PointLight(GOLD, 24, 20); warm.position.set(4, -2, 4); scene.add(warm);
      const navy = new THREE.PointLight(NAVY, 18, 20); navy.position.set(-4, -3, 3); scene.add(navy);

      const glass = (color, opacity) => new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity, roughness: 0.18, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.15, side: THREE.DoubleSide });
      const R = 2.5;
      const track = new THREE.Mesh(new THREE.TorusGeometry(R, 0.14, 24, 160), glass('#DCE7F5', 0.5)); group.add(track);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R + 0.55, 0.018, 12, 160), new THREE.MeshStandardMaterial({ color: GOLD, metalness: 0.7, roughness: 0.3 })); group.add(rim);
      const rim2 = new THREE.Mesh(new THREE.TorusGeometry(R - 0.6, 0.012, 12, 160), new THREE.MeshStandardMaterial({ color: NAVY, metalness: 0.5, roughness: 0.4, transparent: true, opacity: 0.55 })); rim2.rotation.x = 0.5; group.add(rim2);
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 1), glass(MINT, 0.55)); group.add(core);
      const halo = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.03, 12, 100), glass(PALE, 0.8)); halo.rotation.x = Math.PI / 2.4; group.add(halo);

      // The arcs start at 12 o'clock and run clockwise. A CCW torus arc of length L that should end at angle a0 starts at a0 - L.
      const arcs = { received: new THREE.Mesh(new THREE.BufferGeometry(), glass(NAVY, 0.95)), pending: new THREE.Mesh(new THREE.BufferGeometry(), glass(AMBER, 0.95)) };
      arcs.received.scale.set(1, 1, 1.25); arcs.pending.scale.set(1, 1, 1.25);
      group.add(arcs.received, arcs.pending);
      const setArc = (mesh, start, len) => {
        mesh.geometry.dispose();
        if (len <= 0.002) { mesh.visible = false; return; }
        mesh.visible = true; mesh.geometry = new THREE.TorusGeometry(R, 0.2, 24, Math.max(8, Math.round(160 * len)), len * Math.PI * 2);
        mesh.rotation.z = Math.PI / 2 - start * Math.PI * 2 - len * Math.PI * 2;
      };
      const shares = () => { const { received: r, pending: p, left: l } = data.current; const billed = r + l; return billed > 0 ? { r: Math.min(1, r / billed), p: Math.min(Math.max(0, 1 - r / billed), p / billed) } : { r: 0, p: 0 }; };
      let shown = { r: 0, p: 0 }; let from = { r: 0, p: 0 }; let t0 = null; let goal = null;
      const t00 = performance.now();

      return {
        update(t, dt) {
          const s = shares();
          if (!goal || Math.abs(goal.r - s.r) > 1e-6 || Math.abs(goal.p - s.p) > 1e-6) { goal = s; from = { ...shown }; t0 = performance.now(); }
          const now = performance.now();
          const q = Math.min(1, Math.max(0, (now - Math.max(t0, t00 + 250)) / 1400)); // the arcs grow in shortly after the scene appears, and again when the totals change
          if (q < 1 || shown.r !== goal.r || shown.p !== goal.p) {
            const k = ease(q);
            shown = { r: from.r + (goal.r - from.r) * k, p: from.p + (goal.p - from.p) * k };
            setArc(arcs.received, 0, shown.r); setArc(arcs.pending, shown.r, shown.p);
            if (q >= 1) shown = { ...goal };
          }
          group.rotation.y += ((pointer.x * 0.45) - group.rotation.y) * Math.min(1, dt * 2.2) + Math.sin(t * 0.25) * 0.0009;
          group.rotation.x += ((-0.35 - pointer.y * 0.3) - group.rotation.x) * Math.min(1, dt * 2.2);
          rim.rotation.z = t * 0.08; rim2.rotation.z = -t * 0.12; halo.rotation.z = t * 0.2;
          core.rotation.y = t * 0.3; core.rotation.x = t * 0.18; core.position.y = Math.sin(t * 0.8) * 0.08;
        },
        dispose() { arcs.received.geometry.dispose(); arcs.pending.geometry.dispose(); },
      };
    },
  });
  return <div ref={hostRef} className="pa-stage" />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scene B: the desk. `items` are the real payment screenshots: { key, src }. The paper is only a carrier for the original image.
export function ReceiptDesk({ items, selectedKey, onSelect }) {
  const hostRef = useRef(null);
  const live = useRef({ selectedKey, onSelect }); live.current = { selectedKey, onSelect };
  useStage(hostRef, {
    camera: { fov: 32, position: [0, 0, 9.6] },
    shadows: true,
    pixelRatio: 1.75,
    deps: [items.map((i) => `${i.key}|${i.src}`).join(',')],
    build({ THREE, scene, camera, host, canvas, pointer }) {
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const sun = new THREE.DirectionalLight(0xfff3e2, 1.2); sun.position.set(-3.5, 5, 7); sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024); sun.shadow.radius = 6; sun.shadow.camera.left = -9; sun.shadow.camera.right = 9; sun.shadow.camera.top = 6; sun.shadow.camera.bottom = -6; sun.shadow.bias = -0.0005;
      scene.add(sun);
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), new THREE.ShadowMaterial({ opacity: 0.16 })); wall.position.z = -2.4; wall.receiveShadow = true; scene.add(wall);

      const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
      const W = 1.9; const H = 2.6;
      const paperGeo = new THREE.PlaneGeometry(W + 0.16, H + 0.16);
      const cards = items.map((it, idx) => {
        const g = new THREE.Group();
        const paper = new THREE.Mesh(paperGeo, new THREE.MeshBasicMaterial({ color: '#FFFFFF' })); paper.castShadow = true; g.add(paper);
        const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ color: '#FFFFFF' })); face.position.z = 0.004; g.add(face); // unlit: the screenshot keeps its own colours
        loader.load(it.src, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
          const ar = tex.image.width / tex.image.height; // keep the screenshot's own proportions, fitted inside the paper
          const fw = ar > W / H ? W : H * ar; const fh = ar > W / H ? W / ar : H;
          face.geometry.dispose(); face.geometry = new THREE.PlaneGeometry(fw, fh); face.material.map = tex; face.material.color.set('#FFFFFF'); face.material.needsUpdate = true;
        }, undefined, () => {}); // if the image cannot be loaded as a texture the plain paper stays; the gallery below still shows the real screenshot
        g.userData = { key: it.key, idx, phase: idx * 1.7, face };
        g.position.set(0, -6, 0); scene.add(g);
        return g;
      });

      const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
      let hover = null; let vw = 12; let narrow = false;
      const pick = () => { ndc.set(pointer.tx, pointer.ty); ray.setFromCamera(ndc, camera); const hit = ray.intersectObjects(cards.flatMap((c) => c.children), false)[0]; return hit ? hit.object.parent : null; };
      const onClick = (e) => { const r = canvas.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return; pointer.tx = ((e.clientX - r.left) / r.width) * 2 - 1; pointer.ty = -(((e.clientY - r.top) / r.height) * 2 - 1); const hit = pick(); if (hit) live.current.onSelect(hit.userData.key); };
      host.addEventListener('click', onClick);
      canvas.style.pointerEvents = 'none'; host.style.touchAction = 'pan-y'; // taps are caught on the host so vertical scrolling is never trapped

      return {
        resize(w, h, cam) { vw = 2 * Math.tan((cam.fov * Math.PI) / 360) * cam.position.z * cam.aspect; narrow = w < 560; },
        update(t, dt) {
          hover = pointer.inside ? pick() : null; host.style.cursor = hover ? 'pointer' : '';
          const n = cards.length; const sel = live.current.selectedKey;
          const span = Math.min(2.25, (vw * 0.86) / Math.max(1, n)); const k = Math.min(1, dt * 4.5);
          const si = cards.findIndex((c) => c.userData.key === sel);
          cards.forEach((c, i) => {
            const off = i - (n - 1) / 2; const isSel = c.userData.key === sel; const isHover = hover === c;
            const sw = si >= 0 && !isSel ? Math.sign(i - si) * (narrow ? 0.7 : 0.55) : 0; // neighbours step aside for the selected one
            const tx = off * span + sw; const ty = Math.sin(off * 0.9) * 0.18 + Math.sin(t * 0.6 + c.userData.phase) * 0.07 + (isHover ? 0.12 : 0);
            const tz = isSel ? 1.5 : -Math.abs(off) * 0.28 - (i % 2) * 0.35 + (isHover ? 0.3 : 0);
            const trz = isSel ? 0 : off * -0.05 + Math.sin(t * 0.4 + c.userData.phase) * 0.015;
            const try_ = isSel ? 0 : off * 0.12;
            const sc = (isSel ? 1.14 : 0.86 + (isHover ? 0.04 : 0)) * (narrow ? 0.82 : 1);
            c.position.x += (tx - c.position.x) * k; c.position.y += (ty - c.position.y) * k; c.position.z += (tz - c.position.z) * k;
            c.rotation.z += (trz - c.rotation.z) * k; c.rotation.y += ((try_ + pointer.x * 0.1) - c.rotation.y) * k; c.rotation.x += ((-pointer.y * 0.06) - c.rotation.x) * k;
            c.scale.setScalar(c.scale.x + (sc - c.scale.x) * k);
            const fm = c.userData.face.material.color; const shade = isSel || isHover ? 1 : 0.9; fm.setScalar(fm.r + (shade - fm.r) * k); // the ones behind sit a little back in tone
          });
          camera.position.x += (pointer.x * 0.5 - camera.position.x) * Math.min(1, dt * 2); camera.position.y += (pointer.y * 0.3 - camera.position.y) * Math.min(1, dt * 2); camera.lookAt(0, 0, 0);
        },
        dispose() { host.removeEventListener('click', onClick); host.style.cursor = ''; paperGeo.dispose(); },
      };
    },
  });
  return <div ref={hostRef} className="pa-stage pa-desk-stage" />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Scene C: atmosphere. A handful of translucent shapes far behind the page; fixed, low contrast, never interactive.
export function Atmosphere() {
  const hostRef = useRef(null);
  useStage(hostRef, {
    fixed: true,
    pixelRatio: 1.25,
    camera: { fov: 40, position: [0, 0, 14] },
    deps: [],
    build({ THREE, scene, pointer }) {
      scene.add(new THREE.AmbientLight(0xffffff, 1.1));
      const l = new THREE.DirectionalLight(0xffffff, 1.2); l.position.set(-4, 6, 8); scene.add(l);
      const spec = [
        ['ico', MINT, -10.5, 4.6, -4, 1.1], ['oct', NAVY, 10.2, 4.2, -5, 0.8], ['tor', GOLD, 10.6, -4.6, -4, 0.9], ['dod', MINT, -10.8, -4.4, -5, 1.0],
        ['oct', GOLD, -3.6, 7, -8, 0.6], ['ico', NAVY, 4.4, -7, -8, 0.7],
      ];
      const geos = { ico: new THREE.IcosahedronGeometry(1, 0), oct: new THREE.OctahedronGeometry(1, 0), dod: new THREE.DodecahedronGeometry(1, 0), tor: new THREE.TorusGeometry(1, 0.32, 16, 48) };
      const meshes = spec.map(([g, color, x, y, z, s], i) => {
        const m = new THREE.Mesh(geos[g], new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity: 0.13, roughness: 0.25, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false }));
        m.position.set(x, y, z); m.scale.setScalar(s); m.userData = { x, y, z, i }; scene.add(m); return m;
      });
      return {
        update(t) {
          for (const m of meshes) {
            const { x, y, z, i } = m.userData; const depth = 0.4 + (z + 10) * 0.05;
            m.position.x = x + pointer.x * depth + Math.sin(t * 0.1 + i) * 0.35; m.position.y = y + pointer.y * depth * 0.7 + Math.sin(t * 0.14 + i * 2) * 0.4;
            m.rotation.x = t * 0.04 * (1 + (i % 3) * 0.3); m.rotation.y = t * 0.05 * (1 + (i % 2) * 0.4);
          }
        },
        dispose() { Object.values(geos).forEach((g) => g.dispose()); },
      };
    },
  });
  return <div ref={hostRef} className="pa-atmos" aria-hidden="true" />;
}
