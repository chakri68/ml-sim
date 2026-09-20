// Web Worker: headless episode evaluation off the main thread. The request is
// plain data (design, layout, planet, episodes, genomes), the reply is raw
// EpisodeResults per genome. Fitness is scored back on the main thread, so the
// reward sliders never have to round-trip through here. The engine runs a small
// pool of these and splits each population across them.

import { evaluateGenomes, type EvalContext } from "./evaluate.ts";
import type { EpisodeResult, Genome } from "./types.ts";

export type EvalRequest = { id: number; ctx: EvalContext; genomes: Genome[] };

export type EvalResponse =
  | { id: number; ok: true; episodes: EpisodeResult[][] }
  | { id: number; ok: false; error: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<EvalRequest>) => void) | null;
  postMessage: (message: EvalResponse) => void;
};

scope.onmessage = (e) => {
  const { id, ctx, genomes } = e.data;
  try {
    scope.postMessage({ id, ok: true, episodes: evaluateGenomes(ctx, genomes) });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
