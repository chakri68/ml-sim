// Neuroevolution on a fixed-topology network: tournament selection, optional
// uniform crossover, gaussian mutation, elitism. Pure — no physics, no DOM —
// and driven by an injected RNG so a training seed reproduces a run.
//
// Crossover defaults low on purpose. Hidden neurons are interchangeable: two
// parents can compute the same thing with their neurons in a different order,
// so a coin-flip mix of their weights often wires half of one solution into
// half of another and gets neither.

import { paramCount, randomParams } from "./brain.ts";
import { gaussian, type Rng } from "./rng.ts";
import type { BrainLayout, EvolutionConfig, Genome, GenomeResult } from "./types.ts";

export function createInitialPopulation(
  layout: BrainLayout,
  size: number,
  rng: Rng,
  nextId: () => number,
): Genome[] {
  return Array.from({ length: size }, () => ({
    id: nextId(),
    generation: 1,
    parentIds: [],
    params: randomParams(layout, rng),
  }));
}

export function tournamentSelect(
  results: GenomeResult[],
  size: number,
  rng: Rng,
): GenomeResult {
  const k = Math.max(1, Math.min(size, results.length));
  let best = results[Math.floor(rng() * results.length)];
  for (let i = 1; i < k; i++) {
    const c = results[Math.floor(rng() * results.length)];
    if (c.fitness > best.fitness) best = c;
  }
  return best;
}

export function uniformCrossover(a: number[], b: number[], rng: Rng): number[] {
  return a.map((v, i) => (rng() < 0.5 ? v : b[i]));
}

export function mutate(params: number[], config: EvolutionConfig, rng: Rng): number[] {
  return params.map((v) =>
    rng() < config.mutationRate ? v + gaussian(rng) * config.mutationSigma : v,
  );
}

export function pickBest(results: GenomeResult[]): GenomeResult {
  let best = results[0];
  for (const r of results) if (r.fitness > best.fitness) best = r;
  return best;
}

export type NextGeneration = {
  population: Genome[];
  // Aligned to `population`: elites keep their result (episodes are
  // deterministic, so re-running them would give the same numbers).
  cached: (GenomeResult | null)[];
};

export function createNextGeneration(params: {
  results: GenomeResult[];
  config: EvolutionConfig;
  generation: number; // the generation being created
  rng: Rng;
  nextId: () => number;
}): NextGeneration {
  const { results, config, generation, rng, nextId } = params;
  const sorted = [...results].sort((a, b) => b.fitness - a.fitness);
  const eliteCount = Math.min(
    Math.max(0, config.eliteCount),
    Math.floor(config.populationSize / 2),
    sorted.length,
  );
  const population: Genome[] = [];
  const cached: (GenomeResult | null)[] = [];

  for (let i = 0; i < eliteCount; i++) {
    population.push(sorted[i].genome);
    cached.push(sorted[i]);
  }
  while (population.length < config.populationSize) {
    const a = tournamentSelect(results, config.tournamentSize, rng);
    let params: number[];
    let parentIds: number[];
    if (rng() < config.crossoverRate) {
      const b = tournamentSelect(results, config.tournamentSize, rng);
      params = uniformCrossover(a.genome.params, b.genome.params, rng);
      parentIds = a === b ? [a.genome.id] : [a.genome.id, b.genome.id];
    } else {
      params = a.genome.params.slice();
      parentIds = [a.genome.id];
    }
    population.push({
      id: nextId(),
      generation,
      parentIds,
      params: mutate(params, config, rng),
    });
    cached.push(null);
  }
  return { population, cached };
}

// Guard for configs that changed shape under a population (e.g. a sensor was
// switched off): genomes must match the layout's parameter count exactly.
export function fitsLayout(genome: Genome, layout: BrainLayout): boolean {
  return genome.params.length === paramCount(layout);
}
