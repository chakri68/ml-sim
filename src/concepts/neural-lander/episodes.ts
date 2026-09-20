// Episodes are derived from seeds, never stored. Training and evaluation draw
// from two separate seed streams, so an evaluation episode can never leak into
// the fitness that drives selection (design §21).

import { hashSeed, mulberry32 } from "./rng.ts";
import type { Episode, PlanetConfig } from "./types.ts";

// Initial sideways drift. Small on purpose: at ±1 m/s a rover drifts ~10 m
// during a descent, which makes every episode a navigation problem before it's
// a landing problem.
const DRIFT = 0.5;

export function makeEpisode(seed: number, planet: PlanetConfig): Episode {
  const rng = mulberry32(seed);
  const sym = () => rng() * 2 - 1;
  return {
    seed,
    terrainSeed: Math.floor(rng() * 1e6),
    padX: sym() * 10,
    spawnDx: sym() * planet.spawnSpread,
    spawnAltitude: 18 + rng() * 6,
    vx0: sym() * DRIFT,
    vy0: -rng() * 1,
    angle0: sym() * ((5 * Math.PI) / 180),
    windPhase: rng() * Math.PI * 2,
  };
}

export function episodePool(
  poolSeed: number,
  count: number,
  planet: PlanetConfig,
): Episode[] {
  return Array.from({ length: count }, (_, i) =>
    makeEpisode(hashSeed(poolSeed, i), planet),
  );
}
