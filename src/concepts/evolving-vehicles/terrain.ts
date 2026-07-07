// Fixed terrain presets. Points are generated from deterministic formulas (no
// Math.random), so every session and every genome sees the exact same ground —
// which is what makes fitness comparable across the population and across runs.
// The first few metres are always flat to give vehicles a fair run-up.

import type { Terrain, TerrainPoint } from "./types.ts";

const LENGTH = 140; // metres
const STEP = 1; // sample spacing
const FLAT_RUNUP = 8; // metres of flat ground at the start

function build(
  id: string,
  label: string,
  height: (x: number) => number,
): Terrain {
  const points: TerrainPoint[] = [];
  for (let x = -6; x <= LENGTH; x += STEP) {
    const y = x <= FLAT_RUNUP ? 0 : height(x);
    points.push({ x, y });
  }
  return { id, label, points };
}

// eased ramp so a feature doesn't slam in right at the end of the run-up
const ramp = (x: number) => Math.min(1, (x - FLAT_RUNUP) / 6);

// Difficulty is deliberately tuned so a *random* gen-0 car mostly fails (stalls
// on a slope or bounces itself over), leaving evolution real room to improve.
export const terrains: Terrain[] = [
  build("flat", "Flat Ground", () => 0),
  build(
    "small-bumps",
    "Small Bumps",
    (x) => ramp(x) * (0.5 * Math.sin(x * 0.9) + 0.24 * Math.sin(x * 1.9 + 0.7)),
  ),
  build(
    "rolling-hills",
    "Rolling Hills",
    (x) =>
      ramp(x) * (2.5 * Math.sin(x * 0.26) + 0.85 * Math.sin(x * 0.63 + 1.3)),
  ),
];

// Default to Small Bumps: Flat is a trivial baseline (every car succeeds, so it
// reads as "already solved"), whereas bumps show the improvement arc immediately.
export const defaultTerrain = terrains[1];

export function findTerrain(id: string): Terrain {
  return terrains.find((t) => t.id === id) ?? defaultTerrain;
}
