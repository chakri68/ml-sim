// Web Worker: headless population evaluation, off the main thread. It imports
// evaluate.ts (and therefore planck), so all the heavy physics crunching for
// fast-forward happens here — the main thread stays free to render and stay
// responsive. Vite bundles this into its own chunk; the engine spins it up on
// mount and terminates it on cleanup.

import { evaluatePopulation } from "./evaluate.ts";
import type {
  EvolutionConfig,
  Terrain,
  VehicleEvaluationResult,
  VehicleGenome,
} from "./types.ts";

export type EvalRequest = {
  id: number;
  genomes: VehicleGenome[];
  terrain: Terrain;
  config: EvolutionConfig;
};

export type EvalResponse = {
  id: number;
  results: VehicleEvaluationResult[];
};

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<EvalRequest>) => void) | null;
  postMessage: (message: EvalResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, genomes, terrain, config } = e.data;
  const results = evaluatePopulation(genomes, terrain, config);
  ctx.postMessage({ id, results });
};
