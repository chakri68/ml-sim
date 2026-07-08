// The genetic operators — pure, no physics and no DOM. Tournament selection,
// grouped crossover (a whole gene group comes from one parent, so a good limb
// shape or gait rhythm survives as a unit instead of being shredded), gaussian
// numeric mutation that respects each gene's per-range mutability and strength,
// and elitism. Like Evolving Creatures, elites are carried forward WITH their
// evaluation result so the engine can skip re-simulating them.

import { clamp } from "../../lib/math.ts";
import { cloneGenome, normalizeGenome, randomGaussian } from "./genome.ts";
import type {
  EvolutionConfig,
  GeneRangeSetting,
  Genome,
  SandboxEvaluationResult,
  Template,
} from "./types.ts";

export function tournamentSelect(
  results: SandboxEvaluationResult[],
  size: number,
): SandboxEvaluationResult {
  const k = Math.max(1, Math.min(size, results.length));
  let best = results[Math.floor(Math.random() * results.length)];
  for (let i = 1; i < k; i++) {
    const c = results[Math.floor(Math.random() * results.length)];
    if (c.fitness > best.fitness) best = c;
  }
  return best;
}

// Grouped uniform crossover: for each gene group, a coin flip decides which
// parent contributes the whole group.
export function groupedCrossover(
  template: Template,
  a: Genome,
  b: Genome,
): Genome {
  const child: Genome = {};
  for (const group of template.geneGroups) {
    const source = Math.random() < 0.5 ? a : b;
    for (const g of template.genes) {
      if (g.group === group) child[g.key] = source[g.key];
    }
  }
  // Any gene whose group wasn't listed (defensive) falls back to parent a.
  for (const g of template.genes)
    if (!(g.key in child)) child[g.key] = a[g.key];
  return child;
}

// Each mutable gene has `mutationRate` chance of a gaussian nudge, sized by its
// own search-window width times its own strength times the global multiplier —
// so every gene mutates on a comparable, range-relative scale.
export function mutate(
  template: Template,
  genome: Genome,
  ranges: Record<string, GeneRangeSetting>,
  config: EvolutionConfig,
): Genome {
  const out = cloneGenome(genome);
  for (const g of template.genes) {
    const r = ranges[g.key];
    if (!r.mutable) continue;
    if (Math.random() > config.mutationRate) continue;
    const sigma =
      r.mutationStrength * config.mutationStrength * (r.max - r.min);
    out[g.key] = clamp(out[g.key] + randomGaussian() * sigma, r.min, r.max);
  }
  return out;
}

export function pickBest(
  results: SandboxEvaluationResult[],
): SandboxEvaluationResult {
  let best = results[0];
  for (let i = 1; i < results.length; i++) {
    if (results[i].fitness > best.fitness) best = results[i];
  }
  return best;
}

export type NextGeneration = {
  population: Genome[];
  // Aligned to `population`: a cached result for carried-over elites, null for
  // fresh children the engine must evaluate.
  cached: (SandboxEvaluationResult | null)[];
};

export function createNextGeneration(params: {
  template: Template;
  ranges: Record<string, GeneRangeSetting>;
  results: SandboxEvaluationResult[];
  config: EvolutionConfig;
}): NextGeneration {
  const { template, ranges, results, config } = params;
  const sorted = [...results].sort((a, b) => b.fitness - a.fitness);
  const eliteCount = clamp(
    config.eliteCount,
    0,
    Math.floor(config.populationSize / 2),
  );

  const population: Genome[] = [];
  const cached: (SandboxEvaluationResult | null)[] = [];

  for (let i = 0; i < eliteCount && i < sorted.length; i++) {
    population.push(sorted[i].genome); // same reference: identity = "is an elite"
    cached.push(sorted[i]);
  }
  while (population.length < config.populationSize) {
    const parentA = tournamentSelect(results, config.tournamentSize);
    const parentB = tournamentSelect(results, config.tournamentSize);
    const crossed =
      Math.random() < config.crossoverRate
        ? groupedCrossover(template, parentA.genome, parentB.genome)
        : cloneGenome(
            (parentA.fitness >= parentB.fitness ? parentA : parentB).genome,
          );
    population.push(
      normalizeGenome(
        template,
        mutate(template, crossed, ranges, config),
        ranges,
      ),
    );
    cached.push(null);
  }
  return { population, cached };
}
