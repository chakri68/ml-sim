// Headless evaluation: run one phenotype through physics at the fixed timestep
// for a fixed duration (or until it explodes / gets stuck), collect its metrics,
// then score them with the user's compiled fitness expression. No rendering —
// this is the fast path the GA loop runs over the whole population in the worker.

import {
  compileFitness,
  breakdownFitness,
  scoreFitness,
  type CompiledFitness,
} from "./fitnessDsl.ts";
import type { FitnessMetrics } from "./metrics.ts";
import { createSingleSim, FIXED_DT, type RawResult } from "./physics.ts";
import type {
  EvolutionConfig,
  Genome,
  SandboxEvaluationResult,
  Template,
  Terrain,
} from "./types.ts";

// Wrap raw metrics with a fitness score + breakdown. Used both here and by the
// engine to score the live on-screen race (which already has raw metrics).
export function scoreRaw(
  raw: RawResult,
  compiled: CompiledFitness,
): SandboxEvaluationResult {
  return scoreMetrics(raw.genome, raw.metrics, compiled);
}

export function scoreMetrics(
  genome: Genome,
  metrics: FitnessMetrics,
  compiled: CompiledFitness,
): SandboxEvaluationResult {
  return {
    genome,
    metrics,
    fitness: scoreFitness(compiled.ast, metrics),
    breakdown: breakdownFitness(compiled, metrics),
  };
}

export function evaluateGenome(
  template: Template,
  genome: Genome,
  terrain: Terrain,
  compiled: CompiledFitness,
  config: EvolutionConfig,
): SandboxEvaluationResult {
  const sim = createSingleSim(template, genome, terrain);
  const maxSteps = Math.round(config.evaluationSeconds / FIXED_DT);
  for (let i = 0; i < maxSteps; i++) {
    sim.step();
    if (sim.done()) break;
  }
  const result = scoreMetrics(genome, sim.metrics, compiled);
  sim.destroy();
  return result;
}

// Evaluate a whole population. `cached` (aligned to `population`) lets carried
// elites reuse their prior result instead of re-simulating.
export function evaluatePopulation(
  template: Template,
  population: Genome[],
  terrain: Terrain,
  fitnessSource: string,
  config: EvolutionConfig,
  cached?: (SandboxEvaluationResult | null)[],
): SandboxEvaluationResult[] {
  const compiled = compileFitness(fitnessSource);
  return population.map(
    (g, i) =>
      cached?.[i] ?? evaluateGenome(template, g, terrain, compiled, config),
  );
}
