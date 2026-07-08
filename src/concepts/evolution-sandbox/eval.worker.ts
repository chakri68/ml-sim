// Web Worker: headless population evaluation, off the main thread. It imports
// evaluate.ts (and therefore the templates, and therefore planck), so all the
// heavy physics crunching for fast-forward happens here. The main thread stays
// free to render. Vite bundles this into its own chunk.
//
// The request carries ids (templateId, terrainId) and the fitness SOURCE string
// rather than live objects — the worker re-resolves the template/terrain and
// recompiles the expression, keeping the message small and serializable.

import { evaluatePopulation } from "./evaluate.ts";
import { findTemplate } from "./templates/index.ts";
import { findTerrain } from "./terrain.ts";
import type {
  EvolutionConfig,
  Genome,
  SandboxEvaluationResult,
} from "./types.ts";

export type EvalRequest = {
  id: number;
  templateId: string;
  terrainId: string;
  fitnessSource: string;
  genomes: Genome[];
  config: EvolutionConfig;
};

export type EvalResponse =
  | { id: number; ok: true; results: SandboxEvaluationResult[] }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<EvalRequest>) => void) | null;
  postMessage: (message: EvalResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, templateId, terrainId, fitnessSource, genomes, config } = e.data;
  try {
    const template = findTemplate(templateId);
    const terrain = findTerrain(terrainId);
    const results = evaluatePopulation(
      template,
      genomes,
      terrain,
      fitnessSource,
      config,
    );
    ctx.postMessage({ id, ok: true, results });
  } catch (err) {
    ctx.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
