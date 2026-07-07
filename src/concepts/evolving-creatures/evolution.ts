// The genetic operators — pure, no physics and no DOM. Tournament selection,
// grouped crossover (whole gene-groups come from one parent, so a good limb shape
// or a good gait rhythm survives as a unit instead of being shredded), gaussian
// numeric mutation, and elitism. The next generation carries its elites forward
// WITH their evaluation results, so the engine can skip re-simulating them — a
// free speedup on a deterministic sim and a guard against champion flicker.

import { clamp } from "../../lib/math.ts";
import {
  cloneGenome,
  GENE_GROUPS,
  GENES,
  normalizeGenome,
  randomGaussian,
} from "./genome.ts";
import type {
  CreatureEvaluationResult,
  CreatureGenome,
  EvolutionConfig,
  GeneKey,
} from "./types.ts";
import type { GeneGroup } from "./genome.ts";

// Precompute which gene keys live in each group, once.
const KEYS_BY_GROUP: Record<GeneGroup, GeneKey[]> = GENE_GROUPS.reduce(
  (acc, group) => {
    acc[group] = GENES.filter((g) => g.group === group).map((g) => g.key);
    return acc;
  },
  {} as Record<GeneGroup, GeneKey[]>,
);

export function tournamentSelect(
  results: CreatureEvaluationResult[],
  size: number,
): CreatureEvaluationResult {
  const k = Math.max(1, Math.min(size, results.length));
  let best = results[Math.floor(Math.random() * results.length)];
  for (let i = 1; i < k; i++) {
    const c = results[Math.floor(Math.random() * results.length)];
    if (c.fitness > best.fitness) best = c;
  }
  return best;
}

// Grouped uniform crossover: for each gene group, a coin flip decides which
// parent contributes the whole group. Keeps useful substructures intact.
export function groupedCrossover(
  a: CreatureGenome,
  b: CreatureGenome,
): CreatureGenome {
  const child = {} as CreatureGenome;
  for (const group of GENE_GROUPS) {
    const source = Math.random() < 0.5 ? a : b;
    for (const key of KEYS_BY_GROUP[group]) child[key] = source[key];
  }
  return child;
}

// Each gene has `mutationRate` chance of a gaussian nudge sized to its own range
// (mutationStrength is a fraction of range), so all genes mutate on a comparable
// scale regardless of units.
export function mutate(
  genome: CreatureGenome,
  config: EvolutionConfig,
): CreatureGenome {
  const out = cloneGenome(genome);
  for (const g of GENES) {
    if (Math.random() > config.mutationRate) continue;
    const sigma = config.mutationStrength * (g.max - g.min);
    out[g.key] = clamp(out[g.key] + randomGaussian() * sigma, g.min, g.max);
  }
  return out;
}

export function pickBest(
  results: CreatureEvaluationResult[],
): CreatureEvaluationResult {
  let best = results[0];
  for (let i = 1; i < results.length; i++) {
    if (results[i].fitness > best.fitness) best = results[i];
  }
  return best;
}

export type NextGeneration = {
  population: CreatureGenome[];
  // Aligned to `population`: a cached result for carried-over elites, null for
  // fresh children the engine must evaluate.
  cached: (CreatureEvaluationResult | null)[];
};

export function createNextCreatureGeneration(params: {
  results: CreatureEvaluationResult[];
  config: EvolutionConfig;
}): NextGeneration {
  const { results, config } = params;
  const sorted = [...results].sort((a, b) => b.fitness - a.fitness);
  const eliteCount = clamp(
    config.eliteCount,
    0,
    Math.floor(config.populationSize / 2),
  );

  const population: CreatureGenome[] = [];
  const cached: (CreatureEvaluationResult | null)[] = [];

  for (let i = 0; i < eliteCount && i < sorted.length; i++) {
    population.push(sorted[i].genome); // same reference: identity = "is an elite"
    cached.push(sorted[i]);
  }
  while (population.length < config.populationSize) {
    const parentA = tournamentSelect(results, config.tournamentSize);
    const parentB = tournamentSelect(results, config.tournamentSize);
    const crossed =
      Math.random() < config.crossoverRate
        ? groupedCrossover(parentA.genome, parentB.genome)
        : cloneGenome(
            (parentA.fitness >= parentB.fitness ? parentA : parentB).genome,
          );
    population.push(normalizeGenome(mutate(crossed, config)));
    cached.push(null);
  }
  return { population, cached };
}
