// Headless evaluation: run a creature through the physics world at the fixed
// timestep for a fixed duration (or until it explodes / gets stuck), then score
// it. No rendering — this is the fast path the GA loop runs over the whole
// population during fast-forward (in the worker).

import { calculateCreatureFitness } from "./fitness.ts";
import { createCreatureSim, FIXED_DT } from "./physics.ts";
import type {
  CreatureEvaluationResult,
  CreatureGenome,
  EvolutionConfig,
  Terrain,
} from "./types.ts";

export function evaluateCreatureGenome(
  genome: CreatureGenome,
  terrain: Terrain,
  config: EvolutionConfig,
): CreatureEvaluationResult {
  const sim = createCreatureSim(genome, terrain);
  const maxSteps = Math.round(config.evaluationSeconds / FIXED_DT);
  for (let i = 0; i < maxSteps; i++) {
    sim.step();
    if (sim.done()) break;
  }
  const m = sim.metrics;
  const result: CreatureEvaluationResult = {
    genome,
    maxX: m.maxX,
    finalX: m.finalX,
    averageVelocityX: m.averageVelocityX,
    timeAlive: m.timeAlive,
    energyUsed: m.energyUsed,
    fellOver: m.fellOver,
    bodyGroundContactSeconds: m.bodyGroundContactSeconds,
    excessiveRotationSeconds: m.excessiveRotationSeconds,
    instabilityScore: m.instabilityScore,
    fitness: 0,
  };
  result.fitness = calculateCreatureFitness(result);
  sim.destroy();
  return result;
}

// Evaluate a whole population. `cached` (aligned to `population`) lets carried
// elites reuse their prior result instead of re-simulating — see evolution.ts.
export function evaluateCreaturePopulation(
  population: CreatureGenome[],
  terrain: Terrain,
  config: EvolutionConfig,
  cached?: (CreatureEvaluationResult | null)[],
): CreatureEvaluationResult[] {
  return population.map(
    (g, i) => cached?.[i] ?? evaluateCreatureGenome(g, terrain, config),
  );
}
