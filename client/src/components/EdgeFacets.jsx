import { useEffect, useRef } from 'react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';

// A few very soft, slowly drifting facets in the brand blues, caramel and cream, kept to the outer edges of the page.
// They sit in the margins beside the dashboard column (never under a card, chart or control) and are hidden altogether when the window
// is too narrow to leave a margin. Purely decorative: aria-hidden, no information, nothing to click. Without WebGL it renders nothing.
const SHAPES = [
  ['ico', '#A9C9EE', 0.9], ['oct', '#E8C5A2', 0.7], ['dod', '#C7DDF5', 1], ['ico', '#C58A52', 0.55], ['oct', '#B8C8F0', 0.85], ['dod', '#F3E3CF', 0.9], ['ico', '#E7F0FB', 1], ['oct', '#D9A36F', 0.5],
];

export default function EdgeFacets({ contentWidth = 1240 }) {
  const host = useRef(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    let dead = false; let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      if (dead || !host.current) return;
      const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true');
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true }); } catch { return; }
      host.current.appendChild(canvas);
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 100); cam.position.z = 14;
      scene.add(new THREE.AmbientLight(0xffffff, 0.95));
      const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(-3, 4, 6); scene.add(key);
      const geos = []; const mats = []; const items = [];
      for (const [kind, color, op] of SHAPES) {
        const g = kind === 'ico' ? new THREE.IcosahedronGeometry(1, 0) : kind === 'oct' ? new THREE.OctahedronGeometry(1, 0) : new THREE.DodecahedronGeometry(1, 0);
        const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, flatShading: true, transparent: true, opacity: 0.5 * op });
        geos.push(g); mats.push(m);
        const mesh = new THREE.Mesh(g, m); scene.add(mesh);
        items.push({ mesh, phase: Math.random() * 6.28, speed: 0.25 + Math.random() * 0.25, spin: (Math.random() - 0.5) * 0.25 });
      }
      let W = 1; let H = 1; let raf = 0; let start = performance.now();
      // Where the content column ends, in pixels from the window's centre. Facets live only beyond it.
      function layout() {
        const rect = host.current.getBoundingClientRect(); W = Math.max(1, rect.width); H = Math.max(1, rect.height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix();
        const half = Math.min(contentWidth / 2 + 12, W / 2 - 40); const room = W / 2 - half; // free pixels on each side
        const pxToWorld = (2 * Math.tan((cam.fov * Math.PI) / 360) * cam.position.z) / H;
        items.forEach((it, i) => {
          const side = i % 2 ? 1 : -1; const row = Math.floor(i / 2);
          const size = Math.min(room * 0.42, 46) * (0.7 + (i % 3) * 0.18); // radius in px, always smaller than the margin
          it.mesh.scale.setScalar(Math.max(size, 6) * pxToWorld);
          const xPx = half + room * (0.2 + 0.3 * ((i * 37) % 10) / 10) + (side > 0 ? 0 : 0);
          it.base = { x: side * xPx * pxToWorld, y: (H / 2 - (H * (0.14 + 0.2 * row + (side > 0 ? 0.08 : 0)))) * pxToWorld, drift: 10 * pxToWorld };
        });
      }
      function draw(now) {
        raf = 0; const t = (now - start) / 1000;
        for (const it of items) {
          if (!it.base) continue;
          it.mesh.position.set(it.base.x + Math.cos(t * it.speed * 0.8 + it.phase) * it.base.drift * 0.6, it.base.y + Math.sin(t * it.speed + it.phase) * it.base.drift, 0);
          it.mesh.rotation.x = t * it.spin + it.phase; it.mesh.rotation.y = t * it.spin * 1.3;
        }
        renderer.render(scene, cam);
        if (!reduced && !document.hidden) raf = requestAnimationFrame(draw);
      }
      const ro = new ResizeObserver(() => { layout(); if (!raf) raf = requestAnimationFrame(draw); }); ro.observe(host.current); layout();
      const onVis = () => { if (!document.hidden && !raf && !reduced) raf = requestAnimationFrame(draw); }; document.addEventListener('visibilitychange', onVis);
      raf = requestAnimationFrame(draw);
      cleanup = () => {
        cancelAnimationFrame(raf); ro.disconnect(); document.removeEventListener('visibilitychange', onVis);
        geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); renderer.dispose();
        renderer.getContext()?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove();
      };
    })().catch(() => {});
    return () => { dead = true; cleanup(); };
  }, [reduced, contentWidth]);

  return <div ref={host} className="edge-facets" aria-hidden="true" />;
}
