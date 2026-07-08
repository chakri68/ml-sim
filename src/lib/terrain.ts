// Procedural, seeded terrain shared by every physics concept. Terrain is NOT a
// stored array of points — it's a compact, serializable descriptor plus a pure
// height(x) function. That buys three things at once:
//
//   1. Infinite ground. The view samples only the visible window each frame, so
//      the world scrolls forever; physics builds edges over a generous bounded
//      reach (as far as any body could travel in the evaluation window).
//   2. Determinism. A hardcoded seed makes the same terrain every run, so
//      fitness stays comparable and champion replays / imports reproduce exactly.
//   3. Worker-safety. The descriptor is all primitives, so it survives
//      postMessage unchanged — the height function lives in code on both sides.
//
// The height is a sum of sine "octaves" whose phases are derived from the seed,
// eased in after a flat run-up so a body always gets a fair start.

export type TerrainProfile = "flat" | "bumps" | "hills" | "ramp";

export type Terrain = {
  id: string;
  label: string;
  seed: number;
  profile: TerrainProfile;
  amplitude: number; // metres — vertical scale of the noise
  slope: number; // metres of rise per metre (for "ramp"); 0 otherwise
  runup: number; // metres of flat ground before features begin
};

export type TerrainPoint = { x: number; y: number };

export function makeTerrain(
  id: string,
  label: string,
  profile: TerrainProfile,
  opts: {
    seed?: number;
    amplitude?: number;
    slope?: number;
    runup?: number;
  } = {},
): Terrain {
  return {
    id,
    label,
    profile,
    seed: opts.seed ?? 1,
    amplitude: opts.amplitude ?? 0,
    slope: opts.slope ?? 0,
    runup: opts.runup ?? 4,
  };
}

// --- seeded octaves --------------------------------------------------------
type Octave = { freq: number; amp: number; phase: number };

// Base frequency/amplitude bands per profile (amps sum to ~1 so `amplitude` is a
// close-to-literal peak height in metres). "bumps" is high-frequency chatter;
// "hills" is broad rolling waves.
const PROFILE_BANDS: Record<
  Exclude<TerrainProfile, "flat">,
  Array<{ freq: number; amp: number }>
> = {
  bumps: [
    { freq: 0.5, amp: 0.55 },
    { freq: 1.1, amp: 0.3 },
    { freq: 2.1, amp: 0.15 },
  ],
  hills: [
    { freq: 0.08, amp: 0.62 },
    { freq: 0.17, amp: 0.28 },
    { freq: 0.35, amp: 0.12 },
  ],
  ramp: [
    { freq: 0.6, amp: 0.6 },
    { freq: 1.3, amp: 0.4 },
  ],
};

// Small, fast, deterministic PRNG (mulberry32) — seeds the octave phases and a
// gentle per-octave frequency jitter so different seeds look genuinely different.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Octaves are pure functions of (profile, seed), so cache them per descriptor.
const octaveCache = new Map<string, Octave[]>();

function octavesFor(
  profile: Exclude<TerrainProfile, "flat">,
  seed: number,
): Octave[] {
  const key = `${profile}:${seed}`;
  const cached = octaveCache.get(key);
  if (cached) return cached;
  const rand = mulberry32(seed);
  const octaves = PROFILE_BANDS[profile].map((band) => ({
    freq: band.freq * (0.85 + rand() * 0.3), // ±15% frequency jitter
    amp: band.amp,
    phase: rand() * Math.PI * 2,
  }));
  octaveCache.set(key, octaves);
  return octaves;
}

// eased run-up: 0 under the spawn, ramping to 1 over the 6 m after the flat patch
function runupEase(x: number, runup: number): number {
  return Math.min(1, Math.max(0, (x - runup) / 6));
}

export function terrainHeight(t: Terrain, x: number): number {
  if (t.profile === "flat" || t.amplitude === 0) {
    // a pure ramp with no noise still wants its slope
    if (t.slope === 0) return 0;
    return runupEase(x, t.runup) * t.slope * Math.max(0, x - t.runup);
  }
  const octaves = octavesFor(t.profile, t.seed);
  let base = 0;
  for (const o of octaves) base += o.amp * Math.sin(x * o.freq + o.phase);
  let h = t.amplitude * base;
  if (t.slope !== 0) h += t.slope * Math.max(0, x - t.runup);
  return runupEase(x, t.runup) * h;
}

// Sample the height at a fixed spacing over [fromX, toX]. Used by physics to
// build ground edges over the reachable range, and by the view to draw the
// visible window.
export function sampleTerrain(
  t: Terrain,
  fromX: number,
  toX: number,
  step: number,
): TerrainPoint[] {
  const points: TerrainPoint[] = [];
  for (let x = fromX; x <= toX; x += step)
    points.push({ x, y: terrainHeight(t, x) });
  const last = points[points.length - 1];
  if (!last || last.x < toX) points.push({ x: toX, y: terrainHeight(t, toX) });
  return points;
}
