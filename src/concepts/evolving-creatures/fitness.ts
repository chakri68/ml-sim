// Fitness rewards useful forward locomotion and punishes the degenerate tricks a
// distance-only reward invites: spinning yourself forward, dragging your body
// like a slug, or thrashing so hard the physics goes unstable. As with Evolving
// Vehicles these weights are a starting point — reward design is part of what the
// exhibit teaches. Fitness is intentionally NOT clamped to >= 0: letting hopeless
// early creatures go negative keeps selection able to rank the least-terrible of
// a flailing gen-0 population (a flat floor at 0 makes gen-1 selection random).

import type { CreatureEvaluationResult } from "./types.ts";

export const FITNESS_WEIGHTS = {
  distance: 10, // per metre of best forward reach
  survival: 0.4, // per second spent evaluating without exploding
  speed: 5, // per m/s of average forward velocity
  fall: 55, // one-time penalty for tipping over
  spin: 6, // per second spent spinning too fast
  drag: 1.5, // per second the body scraped the ground (gentle — crawlers drag)
  energy: 0.02, // per unit of motor work
  instability: 2, // per accumulated instability unit
};

export function calculateCreatureFitness(result: CreatureEvaluationResult): number {
  const w = FITNESS_WEIGHTS;
  const distanceScore = result.maxX * w.distance;
  const survivalBonus = result.timeAlive * w.survival;
  const speedBonus = Math.max(0, result.averageVelocityX) * w.speed;

  const fallPenalty = result.fellOver ? w.fall : 0;
  const spinPenalty = result.excessiveRotationSeconds * w.spin;
  const dragPenalty = result.bodyGroundContactSeconds * w.drag;
  const energyPenalty = result.energyUsed * w.energy;
  const instabilityPenalty = result.instabilityScore * w.instability;

  return (
    distanceScore +
    survivalBonus +
    speedBonus -
    fallPenalty -
    spinPenalty -
    dragPenalty -
    energyPenalty -
    instabilityPenalty
  );
}
