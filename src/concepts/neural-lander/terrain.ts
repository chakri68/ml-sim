// Lander terrain: the shared seeded-octave generator (src/lib/terrain.ts) for the
// rough ground, with a flat landing pad pressed into it. The ground is ONE
// polyline on a uniform grid, and everything reads that same polyline — planck
// builds its chain from it, range sensors raycast against it, the view draws it —
// so a ray hits exactly what the hull would.

import { makeTerrain, terrainHeight } from "../../lib/terrain.ts";
import type { Episode, PlanetConfig, Vec } from "./types.ts";

export const GROUND_HALF = 60; // m of ground either side of the pad
export const GROUND_STEP = 0.5;
const SHOULDER = 2.5; // m over which the pad blends back into the terrain

export type Ground = {
  padX: number;
  padY: number;
  padHalfWidth: number;
  x0: number; // x of points[0]; points are GROUND_STEP apart
  points: Vec[];
};

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export function buildGround(planet: PlanetConfig, episode: Episode): Ground {
  // Broad hills plus a little chatter. A hugely negative run-up disables the
  // lib's flat start, which exists for the vehicles' starting line.
  const hills = makeTerrain("hills", "hills", "hills", {
    seed: episode.terrainSeed,
    amplitude: planet.roughness,
    runup: -1e9,
  });
  const bumps = makeTerrain("bumps", "bumps", "bumps", {
    seed: episode.terrainSeed + 7,
    amplitude: planet.roughness * 0.12,
    runup: -1e9,
  });
  const base = (x: number) => terrainHeight(hills, x) + terrainHeight(bumps, x);

  const { padX } = episode;
  const hw = planet.padHalfWidth;
  const padY = base(padX);
  // Start the grid on a pad edge so both edges land exactly on vertices and
  // the pad is a truly flat run of segments.
  const k = Math.ceil((GROUND_HALF - hw) / GROUND_STEP);
  const x0 = padX - hw - k * GROUND_STEP;
  const n = 2 * k + Math.round((2 * hw) / GROUND_STEP) + 1;
  const points: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + i * GROUND_STEP;
    const off = Math.abs(x - padX) - hw;
    const mask = off <= 1e-9 ? 1 : 1 - smoothstep(off / SHOULDER);
    const b = base(x);
    points.push({ x, y: b + (padY - b) * mask });
  }
  return { padX, padY, padHalfWidth: hw, x0, points };
}

// Ground height at x by linear interpolation of the polyline.
export function groundHeight(g: Ground, x: number): number {
  const f = (x - g.x0) / GROUND_STEP;
  const i = Math.min(g.points.length - 2, Math.max(0, Math.floor(f)));
  const a = g.points[i];
  const b = g.points[i + 1];
  const t = Math.min(1, Math.max(0, (x - a.x) / GROUND_STEP));
  return a.y + (b.y - a.y) * t;
}

// Highest ground in [x1, x2] — used to keep spawns clear of hilltops.
export function maxGroundBetween(g: Ground, x1: number, x2: number): number {
  let m = -Infinity;
  for (const p of g.points) if (p.x >= x1 && p.x <= x2) m = Math.max(m, p.y);
  return m;
}

// Distance along a unit ray to the first ground segment it crosses, or
// Infinity within maxDist. Only segments under the ray's x-span are tested.
export function raycastGround(
  g: Ground,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
): number {
  const ex = ox + dx * maxDist;
  const lo = Math.max(0, Math.floor((Math.min(ox, ex) - g.x0) / GROUND_STEP));
  const hi = Math.min(
    g.points.length - 2,
    Math.floor((Math.max(ox, ex) - g.x0) / GROUND_STEP),
  );
  let best = Infinity;
  for (let i = lo; i <= hi; i++) {
    const a = g.points[i];
    const b = g.points[i + 1];
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const den = dx * sy - dy * sx;
    if (Math.abs(den) < 1e-12) continue; // parallel
    const qx = a.x - ox;
    const qy = a.y - oy;
    const t = (qx * sy - qy * sx) / den; // along the ray
    const s = (qx * dy - qy * dx) / den; // along the segment
    if (t >= 0 && t <= maxDist && s >= 0 && s <= 1 && t < best) best = t;
  }
  return best;
}
