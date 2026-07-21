// Genome operations for a body whose STRUCTURE evolves. A genome is
// { legCount, values }; its gene set is always planGenes(legCount). Numeric ops
// walk that set and jitter `values`; structural ops change legCount and add/drop
// the per-leg value keys. This is the payload of design §41.2 — evolution changing
// what the body IS, not just its dial settings.

import { clamp } from "../../lib/math.ts";
import { LEG_FIELDS, MAX_LEGS, MIN_LEGS, planGenes } from "./plan.ts";
import type { EvolutionConfig, GeneSpec, Genome } from "./types.ts";

// Sample a fresh value bag for a given gene set.
function randomValues(genes: GeneSpec[]): Record<string, number> {
  const values: Record<string, number> = {};
  for (const g of genes) values[g.key] = g.min + Math.random() * (g.max - g.min);
  return values;
}

export function createRandomGenome(legCount: number): Genome {
  const count = clamp(legCount, MIN_LEGS, MAX_LEGS);
  return { legCount: count, values: randomValues(planGenes(count)) };
}

export function createInitialPopulation(
  legCount: number,
  size: number,
): Genome[] {
  return Array.from({ length: size }, () => createRandomGenome(legCount));
}

// Coerce a genome into a valid, self-consistent state: legCount in bounds, exactly
// the value keys planGenes(legCount) expects (drop strays from a removed leg, fill
// gaps with defaults), every value clamped to its range.
export function normalizeGenome(genome: Genome): Genome {
  const legCount = clamp(Math.round(genome.legCount), MIN_LEGS, MAX_LEGS);
  const genes = planGenes(legCount);
  const values: Record<string, number> = {};
  for (const g of genes)
    values[g.key] = clamp(genome.values[g.key] ?? g.defaultValue, g.min, g.max);
  return { legCount, values };
}

export function cloneGenome(genome: Genome): Genome {
  return { legCount: genome.legCount, values: { ...genome.values } };
}

// ---------------------------------------------------------- structural ops
// The five keys of leg i, e.g. leg2ShoulderAmp … leg2Torque.
function legKeys(i: number): string[] {
  return LEG_FIELDS.map((f) => `leg${i}${f}`);
}

// Append one leg. `source` (if given and valid) is copied so the new leg behaves
// like an existing one — the "duplicate" op; otherwise the new leg is random,
// letting evolution try a genuinely novel limb.
function addLeg(genome: Genome, source: number | null): Genome {
  if (genome.legCount >= MAX_LEGS) return genome;
  const newIndex = genome.legCount;
  const values = { ...genome.values };
  const srcGenes = planGenes(1); // just to reach the per-leg specs for randoms
  for (const f of LEG_FIELDS) {
    const key = `leg${newIndex}${f}`;
    if (source !== null && `leg${source}${f}` in genome.values) {
      values[key] = genome.values[`leg${source}${f}`];
    } else {
      const spec = srcGenes.find((g) => g.key === `leg0${f}`);
      values[key] = spec ? spec.min + Math.random() * (spec.max - spec.min) : 0;
    }
  }
  return normalizeGenome({ legCount: newIndex + 1, values });
}

// Drop the last leg (never below MIN_LEGS). normalizeGenome strips its stray keys.
function removeLeg(genome: Genome): Genome {
  if (genome.legCount <= MIN_LEGS) return genome;
  const values = { ...genome.values };
  for (const key of legKeys(genome.legCount - 1)) delete values[key];
  return normalizeGenome({ legCount: genome.legCount - 1, values });
}

// One structural mutation: grow (novel leg), duplicate (copy an existing leg), or
// shrink. Weighted to nudge toward keeping/adding a little more than dropping, so a
// population doesn't collapse to the minimum body under a distance reward.
function structuralMutate(genome: Genome): Genome {
  const roll = Math.random();
  if (roll < 0.35) return addLeg(genome, null); // grow a new random leg
  if (roll < 0.7) {
    const src = Math.floor(Math.random() * genome.legCount);
    return addLeg(genome, src); // duplicate an existing leg
  }
  return removeLeg(genome);
}

// ---------------------------------------------------------- numeric mutation
function numericMutate(genome: Genome, config: EvolutionConfig): Genome {
  const genes = planGenes(genome.legCount);
  const values = { ...genome.values };
  for (const g of genes) {
    if (Math.random() > config.mutationRate) continue;
    const sigma = config.mutationStrength * (g.max - g.min);
    values[g.key] = clamp(
      (values[g.key] ?? g.defaultValue) + randomGaussian() * sigma,
      g.min,
      g.max,
    );
  }
  return { legCount: genome.legCount, values };
}

// The full mutation step: a rare structural change (§23 suggests ~5%), then the
// usual per-gene numeric jitter over whatever structure survived.
export function mutate(genome: Genome, config: EvolutionConfig): Genome {
  let g = genome;
  if (Math.random() < config.structuralRate) g = structuralMutate(g);
  return numericMutate(g, config);
}

// Standard normal via Box-Muller — small nudges common, big jumps rare.
export function randomGaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
