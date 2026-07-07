// Web Worker: headless population evaluation, off the main thread. It imports
// evaluate.ts (and therefore planck), so all the heavy physics crunching for
// fast-forward happens here — the main thread stays free to render and stay
// responsive. Vite bundles this into its own chunk; the engine spins it up on
// mount and terminates it on cleanup.

import { evaluateCreaturePopulation } from "./evaluate.ts";
import type {
  CreatureEvaluationResult,
  CreatureGenome,
  EvolutionConfig,
  Terrain,
} from "./types.ts";

export type EvalRequest = {
  id: number;
  genomes: CreatureGenome[];
  terrain: Terrain;
  config: EvolutionConfig;
};

export type EvalResponse = {
  id: number;
  results: CreatureEvaluationResult[];
};

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<EvalRequest>) => void) | null;
  postMessage: (message: EvalResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, genomes, terrain, config } = e.data;
  const results = evaluateCreaturePopulation(genomes, terrain, config);
  ctx.postMessage({ id, results });
};
