// The gene schema and everything derived from it. One table (GENES) defines each
// gene's legal range, display grouping, and label — so random creation, clamping,
// crossover, mutation, and the inspector are all one-liners over that table
// instead of a wall of per-field code.

import { clamp } from "../../lib/math.ts";
import type { EvolutionConfig, GeneKey, VehicleGenome } from "./types.ts";

export type GeneSpec = {
  key: GeneKey;
  group: "Body" | "Wheels" | "Motors" | "Suspension";
  label: string;
  min: number;
  max: number;
  unit?: string;
};

// Ranges are in world units where physical (metres), or normalized 0..1 where a
// mapping to physical values happens in physics.ts. front/rear wheel-X ranges
// don't overlap, which enforces "front wheel ahead of rear" without a
// cross-gene constraint.
export const GENES: GeneSpec[] = [
  { key: "chassisWidth", group: "Body", label: "Chassis width", min: 1.4, max: 4.6, unit: "m" },
  { key: "chassisHeight", group: "Body", label: "Chassis height", min: 0.4, max: 1.6, unit: "m" },
  { key: "chassisFrontScale", group: "Body", label: "Front taper", min: 0.35, max: 1.3 },
  { key: "chassisRearScale", group: "Body", label: "Rear taper", min: 0.35, max: 1.3 },
  { key: "frontWheelRadius", group: "Wheels", label: "Front wheel radius", min: 0.25, max: 1.1, unit: "m" },
  { key: "rearWheelRadius", group: "Wheels", label: "Rear wheel radius", min: 0.25, max: 1.1, unit: "m" },
  { key: "frontWheelX", group: "Wheels", label: "Front wheel pos", min: 0.12, max: 0.5 },
  { key: "rearWheelX", group: "Wheels", label: "Rear wheel pos", min: -0.5, max: -0.12 },
  { key: "frontMotorTorque", group: "Motors", label: "Front motor", min: 0, max: 1 },
  { key: "rearMotorTorque", group: "Motors", label: "Rear motor", min: 0, max: 1 },
  { key: "frontSuspension", group: "Suspension", label: "Front suspension", min: 0, max: 1 },
  { key: "rearSuspension", group: "Suspension", label: "Rear suspension", min: 0, max: 1 },
];

const GENE_BY_KEY: Record<GeneKey, GeneSpec> = Object.fromEntries(
  GENES.map((g) => [g.key, g]),
) as Record<GeneKey, GeneSpec>;

export function geneRange(key: GeneKey): GeneSpec {
  return GENE_BY_KEY[key];
}

export function createRandomGenome(): VehicleGenome {
  const genome = {} as VehicleGenome;
  for (const g of GENES) {
    genome[g.key] = g.min + Math.random() * (g.max - g.min);
  }
  return genome;
}

export function createInitialPopulation(config: EvolutionConfig): VehicleGenome[] {
  return Array.from({ length: config.populationSize }, createRandomGenome);
}

// Clamp every gene back into its legal range. Called after mutation/crossover so
// no invalid vehicle ever reaches the physics engine.
export function normalizeGenome(genome: VehicleGenome): VehicleGenome {
  const out = {} as VehicleGenome;
  for (const g of GENES) out[g.key] = clamp(genome[g.key], g.min, g.max);
  return out;
}

export function cloneGenome(genome: VehicleGenome): VehicleGenome {
  return { ...genome };
}

// Standard normal via Box-Muller, for mutation nudges (small changes common,
// large jumps rare — which is what we want).
export function randomGaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
