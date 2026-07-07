// Fixed terrain presets. Points come from deterministic formulas (no Math.random)
// so every creature and every run sees identical ground — which is what makes
// fitness comparable. Unlike Evolving Vehicles (where flat ground was "already
// solved" at gen 0), here the locomotion itself is the hard part, so Flat Ground
// is the right teaching default: learning to crawl at all is the challenge.

import type { Terrain, TerrainPoint } from "./types.ts";

const LENGTH = 60; // metres (creatures crawl only a few metres, not 140)
const STEP = 0.5;
const FLAT_RUNUP = 4; // a short flat patch under the spawn point

function build(id: string, label: string, height: (x: number) => number): Terrain {
  const points: TerrainPoint[] = [];
  for (let x = -4; x <= LENGTH; x += STEP) {
    const y = x <= FLAT_RUNUP ? 0 : height(x);
    points.push({ x, y });
  }
  return { id, label, points };
}

const ramp = (x: number) => Math.min(1, (x - FLAT_RUNUP) / 5);

// Bumps are deliberately small — creatures are far more fragile than cars, so
// even gentle terrain is a real obstacle for an early flailing gait.
export const terrains: Terrain[] = [
  build("flat", "Flat Ground", () => 0),
  build(
    "small-bumps",
    "Small Bumps",
    (x) => ramp(x) * (0.16 * Math.sin(x * 0.8) + 0.07 * Math.sin(x * 1.9 + 0.6)),
  ),
  build(
    "rolling-hills",
    "Rolling Hills",
    (x) => ramp(x) * (0.6 * Math.sin(x * 0.22) + 0.22 * Math.sin(x * 0.55 + 1.1)),
  ),
];

// Default to Flat Ground: for creatures, just moving forward is hard enough.
export const defaultTerrain = terrains[0];

export function findTerrain(id: string): Terrain {
  return terrains.find((t) => t.id === id) ?? defaultTerrain;
}
