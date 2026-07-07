// The genetic operators — pure, no physics and no DOM. Tournament selection,
// uniform (trait-wise) crossover, gaussian numeric mutation, and elitism. The
// next generation carries its elites forward *with their evaluation results*, so
// the engine can skip re-simulating them — a free speedup on a deterministic sim
// and a guard against champion flicker if any noise ever creeps in.

import { clamp } from "../../lib/math.ts";
import {
  cloneGenome,
  GENES,
  normalizeGenome,
  randomGaussian,
} from "./genome.ts";
import type {
  EvolutionConfig,
  VehicleEvaluationResult,
  VehicleGenome,
} from "./types.ts";

export function tournamentSelect(
  results: VehicleEvaluationResult[],
  size: number,
): VehicleEvaluationResult {
  const k = Math.max(1, Math.min(size, results.length));
  let best = results[Math.floor(Math.random() * results.length)];
  for (let i = 1; i < k; i++) {
    const c = results[Math.floor(Math.random() * results.length)];
    if (c.fitness > best.fitness) best = c;
  }
  return best;
}

// Uniform crossover: each trait comes from either parent by a coin flip. Natural
// for a trait bag where genes are independent (unlike a positional sequence).
export function uniformCrossover(
  a: VehicleGenome,
  b: VehicleGenome,
): VehicleGenome {
  const child = {} as VehicleGenome;
  for (const g of GENES)
    child[g.key] = Math.random() < 0.5 ? a[g.key] : b[g.key];
  return child;
}

// Each gene has `mutationRate` chance of a gaussian nudge sized to its own range
// (mutationStrength is a fraction of range), so all genes mutate on a comparable
// scale regardless of units.
export function mutate(
  genome: VehicleGenome,
  config: EvolutionConfig,
): VehicleGenome {
  const out = cloneGenome(genome);
  for (const g of GENES) {
    if (Math.random() > config.mutationRate) continue;
    const sigma = config.mutationStrength * (g.max - g.min);
    out[g.key] += randomGaussian() * sigma;
  }
  return out;
}

export function pickBest(
  results: VehicleEvaluationResult[],
): VehicleEvaluationResult {
  let best = results[0];
  for (let i = 1; i < results.length; i++) {
    if (results[i].fitness > best.fitness) best = results[i];
  }
  return best;
}

export type NextGeneration = {
  population: VehicleGenome[];
  // Aligned to `population`: a cached result for carried-over elites, null for
  // fresh children the engine must evaluate.
  cached: (VehicleEvaluationResult | null)[];
};

export function createNextGeneration(params: {
  results: VehicleEvaluationResult[];
  config: EvolutionConfig;
}): NextGeneration {
  const { results, config } = params;
  const sorted = [...results].sort((a, b) => b.fitness - a.fitness);
  const eliteCount = clamp(
    config.eliteCount,
    0,
    Math.floor(config.populationSize / 2),
  );

  const population: VehicleGenome[] = [];
  const cached: (VehicleEvaluationResult | null)[] = [];

  for (let i = 0; i < eliteCount && i < sorted.length; i++) {
    population.push(sorted[i].genome); // same reference: identity = "is an elite"
    cached.push(sorted[i]);
  }
  while (population.length < config.populationSize) {
    const parentA = tournamentSelect(results, config.tournamentSize);
    const parentB = tournamentSelect(results, config.tournamentSize);
    const crossed =
      Math.random() < config.crossoverRate
        ? uniformCrossover(parentA.genome, parentB.genome)
        : cloneGenome(
            (parentA.fitness >= parentB.fitness ? parentA : parentB).genome,
          );
    population.push(normalizeGenome(mutate(crossed, config)));
    cached.push(null);
  }
  return { population, cached };
}
