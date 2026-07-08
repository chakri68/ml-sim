// Terrain presets. Each is a compact seeded descriptor (see src/lib/terrain.ts)
// rather than a stored point array, so the ground is procedurally generated,
// effectively infinite, and identical every run — which is what makes fitness
// comparable across the population and across runs. The first few metres are
// always flat to give vehicles a fair run-up.
//
// Difficulty is tuned so a *random* gen-0 car mostly fails (stalls on a slope or
// bounces itself over), leaving evolution real room to improve.

import { makeTerrain, type Terrain } from "../../lib/terrain.ts";

export { terrainHeight, sampleTerrain } from "../../lib/terrain.ts";

const RUNUP = 8;

export const terrains: Terrain[] = [
  makeTerrain("flat", "Flat Ground", "flat", { runup: RUNUP }),
  makeTerrain("small-bumps", "Small Bumps", "bumps", {
    seed: 1337,
    amplitude: 0.65,
    runup: RUNUP,
  }),
  makeTerrain("rolling-hills", "Rolling Hills", "hills", {
    seed: 4242,
    amplitude: 2.6,
    runup: RUNUP,
  }),
];

// Default to Small Bumps: Flat is a trivial baseline (every car succeeds, so it
// reads as "already solved"), whereas bumps show the improvement arc immediately.
export const defaultTerrain = terrains[1];

export function findTerrain(id: string): Terrain {
  return terrains.find((t) => t.id === id) ?? defaultTerrain;
}
