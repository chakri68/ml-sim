// Terrain presets for the sandbox. Each is a compact seeded descriptor (see
// src/lib/terrain.ts) rather than a stored point array, so the ground is
// procedurally generated, effectively infinite, and identical every run.
// Changing terrain invalidates old scores, so the engine resets evolution when
// the user switches.

import { makeTerrain, type Terrain } from "../../lib/terrain.ts";

export { terrainHeight, sampleTerrain } from "../../lib/terrain.ts";

export const terrains: Terrain[] = [
  makeTerrain("flat", "Flat Ground", "flat"),
  makeTerrain("small-bumps", "Small Bumps", "bumps", {
    seed: 1337,
    amplitude: 0.28,
    runup: 4,
  }),
  makeTerrain("rolling-hills", "Rolling Hills", "hills", {
    seed: 4242,
    amplitude: 0.8,
    runup: 4,
  }),
  makeTerrain("ramp", "Ramp", "ramp", {
    seed: 9001,
    amplitude: 0.12,
    slope: 0.08,
    runup: 4,
  }),
];

export const defaultTerrain = terrains[0];

export function findTerrain(id: string): Terrain {
  return terrains.find((t) => t.id === id) ?? defaultTerrain;
}
