// Headless evaluation: run a genome through each episode to the end, no
// rendering. Shared by the eval worker and the Node smoke test. Returns raw
// EpisodeResults; fitness is scored separately (fitness.ts) so the reward can
// change without re-simulating.

import { createLanderSim } from "./physics.ts";
import { buildGround, type Ground } from "./terrain.ts";
import type {
  BrainLayout,
  Episode,
  EpisodeResult,
  Genome,
  PlanetConfig,
  RoverDesign,
} from "./types.ts";

// Everything an evaluation needs, as plain data (worker-safe).
export type EvalContext = {
  design: RoverDesign;
  layout: BrainLayout;
  planet: PlanetConfig;
  episodes: Episode[];
  maxSeconds: number;
};

export function runEpisode(
  ctx: EvalContext,
  params: ArrayLike<number>,
  episode: Episode,
  ground?: Ground,
): EpisodeResult {
  const sim = createLanderSim({
    design: ctx.design,
    layout: ctx.layout,
    params,
    planet: ctx.planet,
    episode,
    maxSeconds: ctx.maxSeconds,
    ground,
  });
  while (!sim.done()) sim.step();
  return sim.result();
}

export function evaluateGenomes(ctx: EvalContext, genomes: Genome[]): EpisodeResult[][] {
  const grounds = ctx.episodes.map((e) => buildGround(ctx.planet, e));
  return genomes.map((g) =>
    ctx.episodes.map((e, i) => runEpisode(ctx, g.params, e, grounds[i])),
  );
}
