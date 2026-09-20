// The reward: how an episode's end state turns into a number. Scored on the
// main thread from stored EpisodeResults, so moving a slider re-ranks the
// population instantly without re-simulating anything.
//
// It's a terminal-state score (like Gym's LunarLander, whose shaped per-step
// rewards telescope into roughly the same thing). Before anyone lands, the
// distance / impact / tilt terms are the only gradient, so they have to point
// at "arrive gently, upright, near the pad".

import type { EpisodeResult, Outcome, RewardWeights } from "./types.ts";

export const DEFAULT_REWARD: RewardWeights = {
  landing: 200,
  touchdown: 50,
  alive: 0,
  fuel: 0.2,
  distance: 2,
  impact: 4,
  tilt: 2,
  crash: 30,
  outOfBounds: 60,
};

const CRASHES = new Set<Outcome>([
  "hard-impact",
  "excessive-horizontal-speed",
  "excessive-tilt",
  "tip-over",
  "out-of-fuel",
]);

export function isCrash(o: Outcome): boolean {
  return CRASHES.has(o);
}

// Came to rest on its legs, pad or not. Rewarding this separately gives
// evolution a stepping stone: land safely anywhere first, then land closer.
// Without it, hovering near the pad until timeout outscores touching down a
// few metres off it, and the population never commits to the ground.
function safeDown(o: Outcome): boolean {
  return o === "landed" || o === "missed-zone";
}

export type RewardTerm = { label: string; value: number };

// Every term separately, for the "why did it score that" breakdown.
export function rewardTerms(r: EpisodeResult, w: RewardWeights): RewardTerm[] {
  return [
    { label: "landing", value: r.outcome === "landed" ? w.landing : 0 },
    { label: "safe touchdown", value: safeDown(r.outcome) ? w.touchdown : 0 },
    { label: "alive", value: w.alive * r.time },
    { label: "fuel left", value: w.fuel * (1 - r.fuelUsed) * 100 },
    { label: "distance", value: -w.distance * r.distance },
    { label: "end speed", value: -w.impact * r.endSpeed },
    { label: "tilt", value: -w.tilt * ((r.endTilt * 180) / Math.PI / 10) },
    { label: "crash", value: isCrash(r.outcome) ? -w.crash : 0 },
    { label: "out of bounds", value: r.outcome === "out-of-bounds" ? -w.outOfBounds : 0 },
  ];
}

export function episodeReward(r: EpisodeResult, w: RewardWeights): number {
  let s = 0;
  for (const t of rewardTerms(r, w)) s += t.value;
  return s;
}

// Fitness is the mean over the training episodes (design §20), so a genome
// can't win by memorising one terrain.
export function fitnessOf(episodes: EpisodeResult[], w: RewardWeights): number {
  if (episodes.length === 0) return 0;
  let s = 0;
  for (const e of episodes) s += episodeReward(e, w);
  return s / episodes.length;
}
