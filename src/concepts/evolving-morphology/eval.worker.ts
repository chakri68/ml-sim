// Web Worker: headless population evaluation, off the main thread. It imports the
// interpreter + physics (and therefore planck), so the heavy physics crunching for
// fast-forward happens here while the main thread stays free. Vite bundles this
// into its own chunk.
//
// The request carries plain data — genomes ({legCount, values}, fully
// serializable) and a terrainId — and the worker returns raw METRICS per genome.
// Fitness scoring stays on the main thread (it's cheap AST eval and keeps the DSL
// out of the worker bundle).

import { buildPhenotype } from "./interpreter.ts";
import { buildCrawlerGraph } from "./plan.ts";
import { MORPH_GROUP, createSingleSim, FIXED_DT } from "./physics.ts";
import { findTerrain } from "./terrain.ts";
import type { FitnessMetrics, Genome } from "./types.ts";

export type EvalRequest = {
  id: number;
  terrainId: string;
  genomes: Genome[];
  evaluationSeconds: number;
};

export type EvalResponse =
  | { id: number; ok: true; metrics: FitnessMetrics[] }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<EvalRequest>) => void) | null;
  postMessage: (message: EvalResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, terrainId, genomes, evaluationSeconds } = e.data;
  try {
    const terrain = findTerrain(terrainId);
    const maxSteps = Math.round(evaluationSeconds / FIXED_DT);
    const metrics = genomes.map((genome) => {
      const sim = createSingleSim(
        (world) =>
          buildPhenotype(buildCrawlerGraph(genome), world, terrain, MORPH_GROUP),
        terrain,
      );
      for (let i = 0; i < maxSteps; i++) {
        sim.step();
        if (sim.done()) break;
      }
      // Copy out of the live tracker so the structured-clone message is a snapshot.
      return { ...sim.metrics };
    });
    ctx.postMessage({ id, ok: true, metrics });
  } catch (err) {
    ctx.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
