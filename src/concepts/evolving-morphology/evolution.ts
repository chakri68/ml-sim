// The genetic operators — pure, no physics, no DOM. Tournament selection,
// variable-length grouped crossover, mutation (numeric + structural), and elitism.
//
// Crossover across DIFFERENT structures is the interesting part now that legCount
// evolves: the child takes its STRUCTURE (legCount) from one parent, then fills
// each gene group from a coin-flipped parent where that parent has the key, falling
// back to the structure parent for legs the other parent doesn't have. So a
// 6-legged child can still inherit body proportions or a front-leg rhythm from a
// 4-legged mate, without inventing genes out of nowhere.

import { clamp } from "../../lib/math.ts";
import { cloneGenome, mutate, normalizeGenome } from "./genome.ts";
import { planGenes, planGroups } from "./plan.ts";
import type { EvaluationResult, EvolutionConfig, Genome } from "./types.ts";

export function tournamentSelect(
  results: EvaluationResult[],
  size: number,
): EvaluationResult {
  const k = Math.max(1, Math.min(size, results.length));
  let best = results[Math.floor(Math.random() * results.length)];
  for (let i = 1; i < k; i++) {
    const c = results[Math.floor(Math.random() * results.length)];
    if (c.fitness > best.fitness) best = c;
  }
  return best;
}

export function crossover(a: Genome, b: Genome): Genome {
  const structParent = Math.random() < 0.5 ? a : b;
  const legCount = structParent.legCount;
  const genes = planGenes(legCount);
  const groups = planGroups(legCount);
  const values: Record<string, number> = {};
  for (const group of groups) {
    const coin = Math.random() < 0.5 ? a : b;
    for (const g of genes) {
      if (g.group !== group) continue;
      const src = g.key in coin.values ? coin : structParent;
      values[g.key] = src.values[g.key] ?? g.defaultValue;
    }
  }
  return normalizeGenome({ legCount, values });
}

export function pickBest(results: EvaluationResult[]): EvaluationResult {
  let best = results[0];
  for (let i = 1; i < results.length; i++)
    if (results[i].fitness > best.fitness) best = results[i];
  return best;
}

export type NextGeneration = {
  population: Genome[];
  cached: (EvaluationResult | null)[];
};

export function createNextGeneration(params: {
  results: EvaluationResult[];
  config: EvolutionConfig;
}): NextGeneration {
  const { results, config } = params;
  const sorted = [...results].sort((a, b) => b.fitness - a.fitness);
  const eliteCount = clamp(
    config.eliteCount,
    0,
    Math.floor(config.populationSize / 2),
  );

  const population: Genome[] = [];
  const cached: (EvaluationResult | null)[] = [];

  for (let i = 0; i < eliteCount && i < sorted.length; i++) {
    population.push(sorted[i].genome);
    cached.push(sorted[i]);
  }
  while (population.length < config.populationSize) {
    const parentA = tournamentSelect(results, config.tournamentSize);
    const parentB = tournamentSelect(results, config.tournamentSize);
    const crossed =
      Math.random() < config.crossoverRate
        ? crossover(parentA.genome, parentB.genome)
        : cloneGenome(
            (parentA.fitness >= parentB.fitness ? parentA : parentB).genome,
          );
    population.push(normalizeGenome(mutate(crossed, config)));
    cached.push(null);
  }
  return { population, cached };
}
