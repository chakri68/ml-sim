// The gene schema and everything derived from it. One table (GENES) defines each
// gene's legal range, display grouping, and label — so random creation, clamping,
// crossover, mutation, and the inspector are all one-liners over that table
// instead of per-field code. Angles are radians; lengths are metres.

import { clamp } from "../../lib/math.ts";
import type { CreatureGenome, EvolutionConfig, GeneKey } from "./types.ts";

export type GeneGroup =
  | "Body"
  | "Limbs"
  | "Gait"
  | "Front Motors"
  | "Rear Motors";

export type GeneSpec = {
  key: GeneKey;
  group: GeneGroup;
  label: string;
  min: number;
  max: number;
  unit?: string;
  // How to show the value in the inspector: plain number, metres, or a fraction
  // of π (nice for phases/amplitudes).
  display?: "num" | "pi";
};

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

export const GENES: GeneSpec[] = [
  { key: "bodyWidth", group: "Body", label: "Body width", min: 1.0, max: 3.0, unit: "m" },
  { key: "bodyHeight", group: "Body", label: "Body height", min: 0.3, max: 1.0, unit: "m" },

  { key: "limbAttach", group: "Limbs", label: "Limb spread", min: 0.2, max: 0.95 },
  { key: "upperLen", group: "Limbs", label: "Upper length", min: 0.35, max: 1.4, unit: "m" },
  { key: "lowerLen", group: "Limbs", label: "Lower length", min: 0.35, max: 1.4, unit: "m" },
  { key: "thickness", group: "Limbs", label: "Limb thickness", min: 0.1, max: 0.3, unit: "m" },

  { key: "gaitFrequency", group: "Gait", label: "Gait tempo", min: 1.5, max: 7.0, unit: "rad/s" },

  { key: "frontShoulderAmp", group: "Front Motors", label: "Shoulder swing", min: 0, max: HALF_PI, display: "pi" },
  { key: "frontShoulderPhase", group: "Front Motors", label: "Shoulder phase", min: 0, max: TWO_PI, display: "pi" },
  { key: "frontKneeAmp", group: "Front Motors", label: "Knee swing", min: 0, max: HALF_PI, display: "pi" },
  { key: "frontKneePhase", group: "Front Motors", label: "Knee phase", min: 0, max: TWO_PI, display: "pi" },
  { key: "frontTorque", group: "Front Motors", label: "Muscle strength", min: 0.2, max: 1.0 },

  { key: "rearShoulderAmp", group: "Rear Motors", label: "Shoulder swing", min: 0, max: HALF_PI, display: "pi" },
  { key: "rearShoulderPhase", group: "Rear Motors", label: "Shoulder phase", min: 0, max: TWO_PI, display: "pi" },
  { key: "rearKneeAmp", group: "Rear Motors", label: "Knee swing", min: 0, max: HALF_PI, display: "pi" },
  { key: "rearKneePhase", group: "Rear Motors", label: "Knee phase", min: 0, max: TWO_PI, display: "pi" },
  { key: "rearTorque", group: "Rear Motors", label: "Muscle strength", min: 0.2, max: 1.0 },
];

const GENE_BY_KEY: Record<GeneKey, GeneSpec> = Object.fromEntries(
  GENES.map((g) => [g.key, g]),
) as Record<GeneKey, GeneSpec>;

export function geneRange(key: GeneKey): GeneSpec {
  return GENE_BY_KEY[key];
}

// Ordered list of gene groups (for the inspector and for grouped crossover).
export const GENE_GROUPS: GeneGroup[] = ["Body", "Limbs", "Gait", "Front Motors", "Rear Motors"];

export function createRandomGenome(): CreatureGenome {
  const genome = {} as CreatureGenome;
  for (const g of GENES) genome[g.key] = g.min + Math.random() * (g.max - g.min);
  return genome;
}

export function createInitialPopulation(config: EvolutionConfig): CreatureGenome[] {
  return Array.from({ length: config.populationSize }, createRandomGenome);
}

// Clamp every gene back into its legal range. Called after mutation/crossover so
// no physically impossible creature ever reaches the physics engine.
export function normalizeGenome(genome: CreatureGenome): CreatureGenome {
  const out = {} as CreatureGenome;
  for (const g of GENES) out[g.key] = clamp(genome[g.key], g.min, g.max);
  return out;
}

export function cloneGenome(genome: CreatureGenome): CreatureGenome {
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
