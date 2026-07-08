// Terrain presets. Each is a compact seeded descriptor (see src/lib/terrain.ts)
// rather than a stored point array, so the ground is procedurally generated,
// effectively infinite, and identical every run — which is what makes fitness
// comparable. Unlike Evolving Vehicles (where flat ground was "already solved" at
// gen 0), here the locomotion itself is the hard part, so Flat Ground is the
// right teaching default: learning to crawl at all is the challenge. Bumps are
// deliberately tiny — creatures are far more fragile than cars.

import { makeTerrain, type Terrain } from "../../lib/terrain.ts";

export { terrainHeight, sampleTerrain } from "../../lib/terrain.ts";

const RUNUP = 4;

export const terrains: Terrain[] = [
  makeTerrain("flat", "Flat Ground", "flat", { runup: RUNUP }),
  makeTerrain("small-bumps", "Small Bumps", "bumps", {
    seed: 1337,
    amplitude: 0.18,
    runup: RUNUP,
  }),
  makeTerrain("rolling-hills", "Rolling Hills", "hills", {
    seed: 4242,
    amplitude: 0.6,
    runup: RUNUP,
  }),
];

// Default to Flat Ground: for creatures, just moving forward is hard enough.
export const defaultTerrain = terrains[0];

export function findTerrain(id: string): Terrain {
  return terrains.find((t) => t.id === id) ?? defaultTerrain;
}
