// 3D view: the loss surface rendered with Three.js, with the optimizer's path
// traced across it. Used for 2D functions. Implements the shared View interface.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { el } from "../../lib/dom.ts";
import type { FuncDef } from "./functions.ts";
import type { EngineState, View } from "./view.ts";

const R = 5; // surface half-span in scene units
const H = 4.5; // surface height in scene units
const SEG = 90; // grid resolution per axis
const LIFT = 0.12; // how far the marker floats above the surface

// amber-phosphor heightmap: glowing amber valleys → dark amber peaks
const C_LOW = new THREE.Color("#ffb000");
const C_MID = new THREE.Color("#b3780a");
const C_HIGH = new THREE.Color("#6b4a10");

export function createView3D(func: FuncDef, reducedMotion: boolean): View {
  const container = el("div", { class: "gd-scene-3d" });

  const [dx0, dx1] = func.domain[0];
  const [dy0, dy1] = func.domain[1];

  // --- normalization: sample the grid to bound heights --------------------
  let fMin = Infinity;
  let fMax = -Infinity;
  for (let i = 0; i <= SEG; i++) {
    for (let j = 0; j <= SEG; j++) {
      const v = func.fn([
        dx0 + ((dx1 - dx0) * i) / SEG,
        dy0 + ((dy1 - dy0) * j) / SEG,
      ]);
      if (Number.isFinite(v)) {
        fMin = Math.min(fMin, v);
        fMax = Math.max(fMax, v);
      }
    }
  }
  const fSpan = fMax - fMin || 1;
  const normH = (f: number) =>
    THREE.MathUtils.clamp((f - fMin) / fSpan, 0, 1.25) * H;
  const sceneX = (fx: number) => ((fx - dx0) / (dx1 - dx0)) * 2 * R - R;
  const sceneZ = (fy: number) => ((fy - dy0) / (dy1 - dy0)) * 2 * R - R;
  const scenePoint = (p: number[]) =>
    new THREE.Vector3(sceneX(p[0]), normH(func.fn(p)) + LIFT, sceneZ(p[1]));

  // --- renderer / scene ---------------------------------------------------
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    container.append(
      el(
        "p",
        { class: "gd-3d-fallback" },
        "3D view needs WebGL, which isn't available in this browser.",
      ),
    );
    return { el: container, update() {}, dispose() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
  camera.position.set(8, 7.5, 8.5);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 6;
  controls.maxDistance = 22;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, H * 0.3, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(6, 12, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xcc8a00, 0.5);
  rim.position.set(-8, 4, -6);
  scene.add(rim);

  // --- surface ------------------------------------------------------------
  const geometry = new THREE.PlaneGeometry(2 * R, 2 * R, SEG, SEG);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const tmp = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const sx = pos.getX(k);
    const sz = pos.getZ(k);
    const fx = dx0 + ((sx + R) / (2 * R)) * (dx1 - dx0);
    const fy = dy0 + ((sz + R) / (2 * R)) * (dy1 - dy0);
    const f = func.fn([fx, fy]);
    const h = Number.isFinite(f) ? normH(f) : 0;
    pos.setY(k, h);
    const t = THREE.MathUtils.clamp(
      Number.isFinite(f) ? (f - fMin) / fSpan : 0,
      0,
      1,
    );
    if (t < 0.5) tmp.copy(C_LOW).lerp(C_MID, t * 2);
    else tmp.copy(C_MID).lerp(C_HIGH, (t - 0.5) * 2);
    colors[k * 3] = tmp.r;
    colors[k * 3 + 1] = tmp.g;
    colors[k * 3 + 2] = tmp.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const surface = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.06,
      side: THREE.DoubleSide,
    }),
  );
  scene.add(surface);

  // faint wireframe overlay for the "soft grid" read
  const wire = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: 0xffb000,
      wireframe: true,
      transparent: true,
      opacity: 0.06,
    }),
  );
  scene.add(wire);

  // --- markers & path -----------------------------------------------------
  const minMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffb000, wireframe: true }),
  );
  if (func.minPoint) {
    minMarker.position.copy(scenePoint(func.minPoint));
    scene.add(minMarker);
  }

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 24, 24),
    new THREE.MeshStandardMaterial({
      color: 0xffb000,
      emissive: 0xcc8a00,
      emissiveIntensity: 0.7,
      roughness: 0.3,
    }),
  );
  ball.position.copy(scenePoint(func.start));
  scene.add(ball);
  let target = ball.position.clone();

  const trailGeom = new THREE.BufferGeometry();
  const trailPositions = new Float32Array(1200 * 3);
  trailGeom.setAttribute(
    "position",
    new THREE.BufferAttribute(trailPositions, 3),
  );
  trailGeom.setDrawRange(0, 0);
  const trail = new THREE.Line(
    trailGeom,
    new THREE.LineBasicMaterial({
      color: 0xffb000,
      transparent: true,
      opacity: 0.9,
    }),
  );
  scene.add(trail);

  // --- sizing -------------------------------------------------------------
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // --- render loop --------------------------------------------------------
  let raf = 0;
  let disposed = false;
  function loop() {
    if (disposed) return;
    resize();
    // ease the ball toward its target for smooth motion between discrete steps
    ball.position.lerp(target, reducedMotion ? 1 : 0.2);
    controls.update();
    if (container.clientWidth) renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  function update(state: EngineState) {
    target = scenePoint(state.pos);
    if (reducedMotion) ball.position.copy(target);

    const pts = state.trail.slice(-1200);
    for (let i = 0; i < pts.length; i++) {
      const v = scenePoint(pts[i]);
      trailPositions[i * 3] = v.x;
      trailPositions[i * 3 + 1] = v.y;
      trailPositions[i * 3 + 2] = v.z;
    }
    trailGeom.attributes.position.needsUpdate = true;
    trailGeom.setDrawRange(0, pts.length);

    const mat = ball.material as THREE.MeshStandardMaterial;
    mat.color.set(
      state.status === "Diverging"
        ? 0xff6b6b
        : state.status === "Overshooting"
          ? 0xff6a2b
          : 0xffb000,
    );
  }

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    geometry.dispose();
    trailGeom.dispose();
    renderer.dispose();
  }

  return { el: container, update, dispose };
}
