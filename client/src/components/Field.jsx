import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';

// The home page's floating field of faceted polyhedra. Ported from the Framer "Facet Field" component (light theme, scroll-story mode):
// the same physics, mouse repulsion, scroll stages and pastel palette. The page scroll position (window.scrollY / innerHeight) drives the story:
// hero cluster on the sides -> drop -> heart -> fly toward the camera. Reduced motion or no WebGL falls back to flat pastel shapes.

const BG = {
  hero: ['#FFFFFF', '#F7F4ED', '#E3E9F3'],
  caramel: ['#FFFDF8', '#F8ECDA', '#EFD9B8'],
  teal: ['#FDFFFE', '#E6F5F2', '#C8E7E2'],
};
const gradient = (c) => `radial-gradient(circle at 50% 42%, ${c[0]} 0%, ${c[1]} 40%, ${c[2]} 100%)`;
const PALETTES = {
  hero: { pastel: '#E7F0FB', light: '#C7DDF5', medium: '#A9C9EE', deep: '#E8C5A2', glass: '#B8E3DE' },
  caramel: { pastel: '#E7F0FB', light: '#E8C5A2', medium: '#E8C5A2', deep: '#B8C8F0', glass: '#B8E3DE' },
  teal: { pastel: '#E7F0FB', light: '#B8E3DE', medium: '#B8E3DE', deep: '#A9C9EE', glass: '#B8C8F0' },
};
const toColors = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, new THREE.Color(v)]));
const ROLES = ['pastel', 'light', 'medium', 'deep', 'glass'];
const OVERLAY = 'radial-gradient(ellipse 46% 40% at 50% 48%, rgba(247,244,237,0.92) 0%, rgba(247,244,237,0.62) 45%, rgba(247,244,237,0) 100%)';

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

// Flat pastel shapes at the sides: used for reduced motion and when WebGL is unavailable.
function StaticFacets() {
  const fills = ['#C7DDF5', '#B8E3DE', '#A9C9EE', '#E8C5A2', '#B8C8F0', '#E7F0FB', '#C7DDF5', '#B8E3DE'];
  const shapes = [[12, 30, 90, 0], [15, 56, 60, 30], [9, 68, 70, 60], [20, 16, 44, 15], [87, 34, 100, 45], [85, 60, 56, 20], [91, 70, 72, 70], [80, 18, 46, 10]];
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" className="facet-static" aria-hidden="true">
      {shapes.map(([x, y, s, r], i) => (
        <polygon key={i} points="0,-1 0.95,-0.31 0.59,0.81 -0.59,0.81 -0.95,-0.31" transform={`translate(${x} ${y}) rotate(${r}) scale(${s / 18})`} fill={fills[i % fills.length]} opacity="0.85" />
      ))}
    </svg>
  );
}

export default function Field() {
  const reduced = usePrefersReducedMotion();
  const [webgl] = useState(() => typeof document !== 'undefined' && webglAvailable());
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const bgRef = useRef(null);
  const overlayRef = useRef(null);
  const live = !reduced && webgl;

  useEffect(() => {
    if (!live) return undefined;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return undefined;

    const mousePos = { x: 99, y: 99, isDown: false };
    const control = { progress: 0, started: false };

    let bgStage = -1;
    const setBg = (stage) => {
      if (stage === bgStage || !bgRef.current) return;
      bgStage = stage;
      bgRef.current.style.background = gradient(stage === 2 ? BG.teal : stage === 1 ? BG.caramel : BG.hero);
    };
    if (overlayRef.current) overlayRef.current.style.background = OVERLAY;

    let scrollRaf = 0;
    const readScroll = () => {
      scrollRaf = 0;
      const vh = window.innerHeight || 1;
      const progress = window.scrollY / vh;
      control.progress = progress;
      if (overlayRef.current) { // the cream text-zone glow fades out as the hero scrolls away
        const t = Math.min(1, Math.max(0, (progress - 0.3) / 0.5));
        overlayRef.current.style.opacity = String(1 - t * t * (3 - 2 * t));
      }
      setBg(progress > 1.55 ? 2 : progress > 0.7 ? 1 : 0);
    };
    const onScroll = () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(readScroll); };
    readScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    const onMove = (e) => { mousePos.x = (e.clientX / window.innerWidth) * 2 - 1; mousePos.y = -(e.clientY / window.innerHeight) * 2 + 1; };
    const onOut = (e) => { if (!e.relatedTarget) { mousePos.x = 99; mousePos.y = 99; } };
    const onDown = () => { mousePos.isDown = true; };
    const onUp = () => { mousePos.isDown = false; };
    window.addEventListener('pointermove', onMove);
    document.addEventListener('pointerout', onOut);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(0, 0, 11);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25; // light theme: keeps the pastel tints from blowing out
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const hemiLight = new THREE.HemisphereLight(0xffffff, new THREE.Color('#A9C9EE'), 1.6);
    scene.add(hemiLight);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(-6, 10, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048; keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5; keyLight.shadow.camera.far = 30;
    keyLight.shadow.camera.left = -8; keyLight.shadow.camera.right = 8; keyLight.shadow.camera.top = 8; keyLight.shadow.camera.bottom = -8;
    keyLight.shadow.bias = -0.0003; keyLight.shadow.radius = 12.0;
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xffffff, 1.25); rimLight.position.set(8, 7, -8); scene.add(rimLight);
    const frontLight = new THREE.DirectionalLight(0xffffff, 0.4); frontLight.position.set(0, 0, 11); scene.add(frontLight);
    const sideBounceLight = new THREE.DirectionalLight(0xffffff, 0.3); sideBounceLight.position.set(-9, -2, 4); scene.add(sideBounceLight);

    let viewportWidth = 10;
    let viewportHeight = 6;
    const updateFrustumBounds = () => {
      const fovRad = THREE.MathUtils.degToRad(camera.fov);
      viewportHeight = 2 * Math.tan(fovRad / 2) * camera.position.z;
      viewportWidth = viewportHeight * (container.clientWidth / container.clientHeight);
    };
    updateFrustumBounds();

    const isMobile = window.innerWidth < 768;
    const ballCount = isMobile ? 24 : 56;

    const palHero = toColors(PALETTES.hero);
    const palMint = toColors(PALETTES.caramel);
    const palPearl = toColors(PALETTES.teal);
    const curPal = Object.fromEntries(ROLES.map((r) => [r, new THREE.Color()]));

    // Polyhedra inscribed in the unit sphere; scaled up slightly so facets meet the collision radius.
    const geometries = [new THREE.IcosahedronGeometry(1, 0), new THREE.DodecahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0)];
    const FACET_SCALE = 1.08;
    const balls = [];
    const materials = [];
    for (let i = 0; i < ballCount; i++) {
      let radius;
      const rand = Math.random();
      if (rand < 0.3) radius = 0.27 + Math.random() * 0.12;
      else if (rand < 0.8) radius = 0.42 + Math.random() * 0.18;
      else radius = 0.66 + Math.random() * 0.21;
      const mass = radius ** 3;

      let sphereMat;
      let role = 'medium';
      const isGlass = Math.random() < 0.22;
      if (isGlass) {
        sphereMat = new THREE.MeshPhysicalMaterial({
          color: palHero.glass, roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.03, transmission: 0.95, ior: 1.485, thickness: 2.2,
          specularColor: new THREE.Color('#ffffff'), specularIntensity: 1.0, attenuationColor: palHero.pastel, attenuationDistance: 1.0,
          emissive: palHero.glass, emissiveIntensity: 0.12, transparent: true, flatShading: true,
        });
        role = 'glass';
      } else {
        const colorRand = Math.random();
        let chosen;
        if (colorRand < 0.25) { chosen = palHero.pastel; role = 'pastel'; }
        else if (colorRand < 0.55) { chosen = palHero.light; role = 'light'; }
        else if (colorRand < 0.85) { chosen = palHero.medium; role = 'medium'; }
        else { chosen = palHero.deep; role = 'deep'; }
        sphereMat = new THREE.MeshPhysicalMaterial({
          color: chosen, roughness: 0.44, metalness: 0.0, clearcoat: 0.24, clearcoatRoughness: 0.35, emissive: chosen, emissiveIntensity: 0.08, transparent: true, flatShading: true,
        });
      }
      materials.push(sphereMat);

      const shapeRand = Math.random();
      const geometry = shapeRand < 0.5 ? geometries[0] : shapeRand < 0.8 ? geometries[1] : geometries[2];
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(geometry, sphereMat);
      mesh.scale.setScalar(radius * FACET_SCALE);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      scene.add(group);

      balls.push({
        id: i, radius, mass, position: new THREE.Vector3(), velocity: new THREE.Vector3(), meshGroup: group, sphere: mesh, material: sphereMat, role, isGlass,
        visualScale: radius, shapeTarget: new THREE.Vector3(), spin: (Math.random() - 0.5) * 0.006, zoneAlpha: 1,
      });
    }

    const meanRadius = balls.reduce((s, b) => s + b.radius, 0) / balls.length;
    let shapeScale = 1;

    const inHeart = (x, y) => { const a = x * x + y * y - 1; return a * a * a - x * x * y * y * y <= 0; };
    const assignHeartTargets = () => {
      const S = Math.min(viewportWidth * 0.3, viewportHeight * 0.27);
      const baseCY = -viewportHeight * 0.03;
      shapeScale = Math.max(0.3, Math.min(1, (S * 0.45) / 2.3 / meanRadius));
      for (let i = 0; i < balls.length; i++) {
        let x = 0, y = 0, tries = 0;
        do { x = (Math.random() * 2 - 1) * 1.25; y = Math.random() * 2.55 - 1.4; tries++; } while (!inHeart(x, y) && tries < 60);
        balls[i].shapeTarget.set(x * S, (y + 0.12) * S + baseCY, (Math.random() - 0.5) * 0.35);
      }
    };
    assignHeartTargets();

    const scatterFar = (withInwardVelocity) => {
      const R = Math.max(viewportWidth, viewportHeight) * 1.5;
      for (const b of balls) {
        const a = Math.random() * Math.PI * 2;
        const px = Math.cos(a) * R * 1.25;
        const py = Math.sin(a) * R * 0.85;
        const pz = (Math.random() - 0.5) * 4;
        b.position.set(px, py, pz);
        b.meshGroup.position.copy(b.position);
        if (withInwardVelocity) b.velocity.set(-px, -py, -pz).normalize().multiplyScalar(0.08 + Math.random() * 0.05);
        else b.velocity.set(0, 0, 0);
      }
    };
    scatterFar(false);

    const params = { rebound: -0.3, mouseRepelForce: 0.05, mouseRepelRadius: 4.4, centerAttractForce: 0.0035, bounciness: 0.02 };

    const mouseProjVec = new THREE.Vector3();
    const mouseWorld3D = new THREE.Vector3();
    const updateMouse3D = () => {
      mouseProjVec.set(mousePos.x, mousePos.y, 0.5);
      mouseProjVec.unproject(camera);
      const dir = mouseProjVec.sub(camera.position).normalize();
      const distance = -camera.position.z / dir.z;
      mouseWorld3D.copy(camera.position).add(dir.multiplyScalar(distance));
    };

    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
    const lerp = (a, b, t) => a + (b - a) * t;
    const easeOutCubic = (t) => 1 - (1 - t) ** 3;

    let animationFrameId = 0;
    const clock = new THREE.Clock();
    let localStarted = false;
    let entranceStart = 0;
    let visible = true;

    const diffVec = new THREE.Vector3();
    const collideDiff = new THREE.Vector3();
    const relVel = new THREE.Vector3();
    const deltaPos = new THREE.Vector3();
    const rotAxis = new THREE.Vector3();
    const prevMouseWorld = new THREE.Vector3();
    let mouseSpeed = 0;

    const simulateAndRender = () => {
      animationFrameId = requestAnimationFrame(simulateAndRender);
      if (!visible) return;
      const time = clock.getElapsedTime();
      updateMouse3D();

      if (!localStarted) { // first frame: render the scattered scene once, then fly the facets in
        renderer.render(scene, camera);
        localStarted = true;
        entranceStart = time;
        scatterFar(true);
        return;
      }

      const progress = control.progress;
      const heroF = 1 - smoothstep(0.3, 0.8, progress);
      const dropRaw = smoothstep(0.4, 0.95, progress);
      const flyF = smoothstep(2.7, 3.45, progress);
      const shapeF = smoothstep(1.4, 2.05, progress) * (1 - smoothstep(2.55, 3.0, progress));
      const dropF = dropRaw * (1 - smoothstep(1.25, 1.75, progress));

      const bMint = smoothstep(0.55, 1.05, progress);
      const bPearl = smoothstep(1.4, 1.95, progress);
      for (const role of ROLES) curPal[role].copy(palHero[role]).lerp(palMint[role], bMint).lerp(palPearl[role], bPearl);
      hemiLight.groundColor.copy(curPal.medium);

      const entranceT = easeOutCubic(clamp01((time - entranceStart) / 2.2));
      const attractionBoost = lerp(7.5, 1, entranceT);
      const isMouseInteracting = Math.abs(mousePos.x) < 0.99 || Math.abs(mousePos.y) < 0.99;

      mouseSpeed = isMouseInteracting ? mouseWorld3D.distanceTo(prevMouseWorld) : 0;
      if (mouseSpeed > 3) mouseSpeed = 3;
      prevMouseWorld.copy(mouseWorld3D);

      let damping = 0.91;
      damping = lerp(damping, 0.992, dropF);
      damping = lerp(damping, 0.9, shapeF);
      damping = lerp(damping, 0.985, flyF);

      const camZ = camera.position.z;
      const clusterActive = Math.max(heroF, entranceT < 1 ? 1 : 0);

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (heroF > 0.01) {
          b.velocity.x += Math.sin(time * 0.4 + b.id * 1.5) * 0.0004 * b.radius * heroF;
          b.velocity.y += Math.cos(time * 0.5 + b.id * 1.2) * 0.0004 * b.radius * heroF;
          b.velocity.z += Math.sin(time * 0.35 + b.id) * 0.0001 * heroF;
        }
        // Hero: facets are drawn to lanes at the left and right edges (above and below the text on phones), never to the middle.
        const clusterStrength = params.centerAttractForce * attractionBoost * clusterActive;
        if (clusterStrength > 0.00001) {
          b.velocity.x += ((!isMobile ? (b.id % 2 ? 1 : -1) * viewportWidth * 0.38 : 0) - b.position.x) * clusterStrength * 0.38;
          b.velocity.y += ((isMobile ? (b.id % 2 ? 1 : -1) * viewportHeight * 0.43 : 0) - b.position.y) * clusterStrength * 1.85;
          b.velocity.z += (0 - b.position.z) * clusterStrength * 1.8;
        }
        // A soft push-out zone keeps facets from settling behind the text, and fades any that stray into it.
        b.zoneAlpha = 1;
        if (heroF > 0.01) {
          const zx = viewportWidth * (isMobile ? 0.5 : 0.35); // wide enough for the 112px headline even at 1200px
          const zy = viewportHeight * (isMobile ? 0.36 : 0.36); // tall enough to include the stats line under the buttons
          const nx = b.position.x / zx;
          const ny = b.position.y / zy;
          const zd = Math.sqrt(nx * nx + ny * ny);
          if (zd < 1) {
            const dd = Math.max(zd, 0.05);
            const push = (1 - zd) * 0.03 * heroF;
            b.velocity.x += (nx / dd) * push;
            b.velocity.y += (ny / dd) * push * 0.6;
            b.zoneAlpha = 1 - 0.65 * (1 - zd) * heroF;
          }
        }
        if (dropF > 0.001) b.velocity.y -= 0.011 * dropF;
        if (shapeF > 0.001) {
          const k = 0.06 * shapeF;
          b.velocity.x += (b.shapeTarget.x - b.position.x) * k;
          b.velocity.y += (b.shapeTarget.y - b.position.y) * k;
          b.velocity.z += (b.shapeTarget.z - b.position.z) * k;
        }
        if (flyF > 0.001) {
          const stagger = (b.id * 0.6180339887) % 1;
          const local = smoothstep(stagger * 0.55, stagger * 0.55 + 0.45, flyF);
          b.velocity.z += 0.05 * local;
          b.velocity.x += b.position.x * 0.006 * local;
          b.velocity.y += b.position.y * 0.006 * local;
        }
        if (isMouseInteracting) {
          diffVec.subVectors(b.position, mouseWorld3D);
          const rawDist = diffVec.length();
          const down = mousePos.isDown;
          const activeRepelRadius = down ? params.mouseRepelRadius * 1.4 : params.mouseRepelRadius;
          const activeRepelForce = down ? params.mouseRepelForce * 1.7 : params.mouseRepelForce;
          if (rawDist < activeRepelRadius && rawDist > 0.0001) {
            const ratio = rawDist / activeRepelRadius;
            const smoothFactor = 1.0 - ratio * ratio * (3.0 - 2.0 * ratio);
            const speedBoost = 1 + mouseSpeed * 3.2;
            const push = smoothFactor * activeRepelForce * speedBoost;
            diffVec.normalize();
            diffVec.z *= 0.12;
            diffVec.normalize();
            b.velocity.addScaledVector(diffVec, push);
          }
        }

        b.velocity.multiplyScalar(damping);
        b.position.addScaledVector(b.velocity, 1);

        const c = b.isGlass ? curPal.glass : curPal[b.role];
        b.material.color.copy(c);
        b.material.emissive.copy(c);
        b.material.opacity = (flyF > 0.001 ? 1 - smoothstep(camZ - 2.6, camZ - 0.3, b.position.z) : 1) * b.zoneAlpha;

        const targetVis = b.radius * (1 - (1 - shapeScale) * shapeF);
        b.visualScale += (targetVis - b.visualScale) * 0.12;
        b.sphere.scale.setScalar(b.visualScale * FACET_SCALE);
      }

      const collideScale = 0.28 * (1 - 0.93 * shapeF) * (1 - flyF);
      const subSteps = 4;
      for (let step = 0; step < subSteps; step++) {
        for (let i = 0; i < balls.length; i++) {
          for (let j = i + 1; j < balls.length; j++) {
            const b1 = balls[i];
            const b2 = balls[j];
            collideDiff.subVectors(b2.position, b1.position);
            const dist = collideDiff.length();
            const minDist = b1.visualScale + b2.visualScale;
            if (dist < minDist && dist > 0.001) {
              const overlap = minDist - dist;
              collideDiff.multiplyScalar(1 / dist);
              const totalMass = b1.mass + b2.mass;
              b1.position.addScaledVector(collideDiff, -overlap * (b2.mass / totalMass) * collideScale);
              b2.position.addScaledVector(collideDiff, overlap * (b1.mass / totalMass) * collideScale);
              relVel.subVectors(b2.velocity, b1.velocity);
              const velAlongNormal = relVel.dot(collideDiff);
              if (velAlongNormal < -0.0001) {
                const impulse = (-(1 + params.bounciness) * velAlongNormal) / (1 / b1.mass + 1 / b2.mass);
                b1.velocity.addScaledVector(collideDiff, -impulse / b1.mass);
                b2.velocity.addScaledVector(collideDiff, impulse / b2.mass);
              }
            }
          }
        }
      }

      const borderPad = 0.2;
      const xBound = viewportWidth / 2 - borderPad;
      const topY = viewportHeight / 2 - 0.05;
      const floorY = -viewportHeight / 2 + 0.05;
      const zBound = 2.0;
      const restitution = 0.3 + 0.35 * dropF;
      const contain = flyF < 0.5;
      const zContain = flyF < 0.02;

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        const r = b.visualScale;
        if (contain) {
          if (b.position.x < -xBound - r) { b.position.x = -xBound - r; b.velocity.x *= params.rebound; }
          else if (b.position.x > xBound + r) { b.position.x = xBound + r; b.velocity.x *= params.rebound; }
          if (b.position.y - r < floorY) {
            b.position.y = floorY + r;
            if (b.velocity.y < 0) b.velocity.y = -b.velocity.y * restitution;
            if (dropF > 0.3) { b.velocity.x *= 0.86; b.velocity.z *= 0.86; }
          }
          if (b.position.y + r > topY) {
            b.position.y = topY - r;
            if (b.velocity.y > 0) b.velocity.y *= params.rebound;
          }
        }
        if (zContain) {
          if (b.position.z < -zBound) { b.position.z = -zBound; b.velocity.z *= params.rebound; }
          else if (b.position.z > zBound) { b.position.z = zBound; b.velocity.z *= params.rebound; }
        }
        deltaPos.copy(b.position).sub(b.meshGroup.position);
        if (deltaPos.lengthSq() > 0.000001) {
          rotAxis.set(deltaPos.y, -deltaPos.x, 0).normalize();
          const rotAngle = (deltaPos.length() / b.radius) * 0.95;
          b.meshGroup.rotateOnWorldAxis(rotAxis, rotAngle);
        }
        b.sphere.rotation.y += b.spin;
        b.meshGroup.position.copy(b.position);
      }

      renderer.render(scene, camera);
    };
    simulateAndRender();

    const handleResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      updateFrustumBounds();
      assignHeartTargets();
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    io.observe(container);

    return () => {
      cancelAnimationFrame(animationFrameId);
      cancelAnimationFrame(scrollRaf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onOut);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      geometries.forEach((geo) => geo.dispose());
      materials.forEach((m) => m.dispose());
      renderer.dispose();
    };
  }, [live]);

  return (
    <div ref={containerRef} className="facet-field" aria-hidden="true">
      <div ref={bgRef} className="facet-bg" style={{ background: gradient(BG.hero) }} />
      {live ? <canvas ref={canvasRef} className="facet-canvas" /> : <StaticFacets />}
      {live && <div ref={overlayRef} className="facet-zone" />}
    </div>
  );
}
