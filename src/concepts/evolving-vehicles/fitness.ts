// Fitness rewards useful forward motion and punishes the degenerate tricks a
// distance-only reward invites (flipping, wheelie-launches, dragging the body,
// brute-force torque). These weights are a starting point — reward design is
// itself part of what this exhibit teaches, so expect to tune them by watching
// the stats. Fitness is intentionally NOT clamped to >= 0: letting bad runs go
// negative keeps selection able to rank the least-terrible of a hopeless early
// population (a flat floor at 0 makes gen-1 selection random).

import type { VehicleEvaluationResult } from "./types.ts";

export const FITNESS_WEIGHTS = {
  distance: 10, // per metre of best forward reach
  survival: 0.5, // per second upright and evaluated
  speed: 6, // per m/s of average forward velocity
  flip: 60, // one-time penalty for ending up flipped
  stuck: 6, // per second spent not moving
  energy: 0.015, // per unit of motor work
  drag: 5, // per second the chassis scraped the ground
};

export function calculateFitness(result: VehicleEvaluationResult): number {
  const w = FITNESS_WEIGHTS;
  const distanceScore = result.maxX * w.distance;
  const survivalBonus = result.timeAlive * w.survival;
  const speedBonus = Math.max(0, result.averageVelocityX) * w.speed;

  const flipPenalty = result.flipped ? w.flip : 0;
  const stuckPenalty = result.stuckSeconds * w.stuck;
  const energyPenalty = result.motorEnergy * w.energy;
  const dragPenalty = result.chassisContactSeconds * w.drag;

  return (
    distanceScore +
    survivalBonus +
    speedBonus -
    flipPenalty -
    stuckPenalty -
    energyPenalty -
    dragPenalty
  );
}
