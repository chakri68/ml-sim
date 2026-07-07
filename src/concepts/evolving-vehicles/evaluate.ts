// Headless evaluation: run a genome through the physics world at the fixed
// timestep for a fixed duration (or until it flips / gets stuck / explodes),
// then score it. No rendering — this is the fast path the GA loop runs over the
// whole population between champion replays.

import { calculateFitness } from "./fitness.ts";
import { createVehicleSim, FIXED_DT } from "./physics.ts";
import type {
  EvolutionConfig,
  Terrain,
  VehicleEvaluationResult,
  VehicleGenome,
} from "./types.ts";

export function evaluateGenome(
  genome: VehicleGenome,
  terrain: Terrain,
  config: EvolutionConfig,
): VehicleEvaluationResult {
  const sim = createVehicleSim(genome, terrain);
  const maxSteps = Math.round(config.evaluationSeconds / FIXED_DT);
  for (let i = 0; i < maxSteps; i++) {
    sim.step();
    if (sim.done()) break;
  }
  const m = sim.metrics;
  const result: VehicleEvaluationResult = {
    genome,
    maxX: m.maxX,
    finalX: m.finalX,
    averageVelocityX: m.averageVelocityX,
    timeAlive: m.timeAlive,
    flipped: m.flipped,
    stuckSeconds: m.stuckSeconds,
    motorEnergy: m.motorEnergy,
    chassisContactSeconds: m.chassisContactSeconds,
    fitness: 0,
  };
  result.fitness = calculateFitness(result);
  sim.destroy();
  return result;
}

// Evaluate a whole population. `cached` (aligned to `population`) lets carried
// elites reuse their prior result instead of re-simulating — see evolution.ts.
export function evaluatePopulation(
  population: VehicleGenome[],
  terrain: Terrain,
  config: EvolutionConfig,
  cached?: (VehicleEvaluationResult | null)[],
): VehicleEvaluationResult[] {
  return population.map(
    (g, i) => cached?.[i] ?? evaluateGenome(g, terrain, config),
  );
}
