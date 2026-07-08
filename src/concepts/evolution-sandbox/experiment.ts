// Export / import a sandbox experiment as JSON. This is what makes evolved
// designs shareable without any backend: the template, the user's gene ranges,
// their fitness expression, the terrain, and the evolution config fully describe
// a reproducible experiment (physics is deterministic, so re-running reaches the
// same place). Import validates before it is allowed to run.

import { validateFitness } from "./fitnessDsl.ts";
import { findTemplate, templates } from "./templates/index.ts";
import { findTerrain } from "./terrain.ts";
import type {
  Blueprint,
  EvolutionConfig,
  GeneRangeSetting,
  SandboxExperiment,
} from "./types.ts";
import { clamp } from "../../lib/math.ts";

export const EXPERIMENT_VERSION = 1;

export function buildExperiment(params: {
  name: string;
  blueprint: Blueprint;
  fitnessExpression: string;
  terrainId: string;
  config: EvolutionConfig;
}): SandboxExperiment {
  return {
    version: EXPERIMENT_VERSION,
    name: params.name,
    templateId: params.blueprint.templateId,
    ranges: params.blueprint.ranges,
    fitnessExpression: params.fitnessExpression,
    terrainId: params.terrainId,
    config: params.config,
  };
}

export function serializeExperiment(exp: SandboxExperiment): string {
  return JSON.stringify(exp, null, 2);
}

export type ImportResult =
  | { ok: true; experiment: SandboxExperiment; warnings: string[] }
  | { ok: false; error: string };

// Parse + validate an imported experiment. We coerce ranges back into the
// template's hard bounds so an out-of-date or hand-edited file can never spawn
// an unsafe body, and we reject an unparseable fitness expression outright.
export function parseExperiment(json: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "That file isn't valid JSON." };
  }
  if (typeof raw !== "object" || raw === null)
    return { ok: false, error: "Experiment must be a JSON object." };
  const obj = raw as Partial<SandboxExperiment>;
  const warnings: string[] = [];

  if (
    typeof obj.templateId !== "string" ||
    !templates.some((t) => t.id === obj.templateId)
  ) {
    return { ok: false, error: `Unknown template "${obj.templateId}".` };
  }
  const template = findTemplate(obj.templateId);

  if (typeof obj.fitnessExpression !== "string")
    return { ok: false, error: "Missing fitness expression." };
  const validation = validateFitness(obj.fitnessExpression);
  if (!validation.ok)
    return {
      ok: false,
      error: `Fitness expression is invalid: ${validation.error}`,
    };

  if (obj.version !== EXPERIMENT_VERSION) {
    warnings.push(
      `Experiment was version ${obj.version ?? "?"}; this build is version ${EXPERIMENT_VERSION}. Loaded with best effort.`,
    );
  }

  // Rebuild ranges from the template, overlaying any provided (clamped) values.
  const ranges: Record<string, GeneRangeSetting> = {};
  for (const g of template.genes) {
    const provided = (obj.ranges ?? {})[g.key];
    const lo = clamp(Number(provided?.min ?? g.min), g.min, g.max);
    const hi = clamp(Number(provided?.max ?? g.max), lo, g.max);
    ranges[g.key] = {
      min: lo,
      max: hi,
      mutable: provided?.mutable ?? true,
      mutationStrength: clamp(
        Number(provided?.mutationStrength ?? 0.1),
        0.01,
        1,
      ),
    };
  }

  const terrainId = findTerrain(
    typeof obj.terrainId === "string" ? obj.terrainId : "flat",
  ).id;
  const cfg = obj.config ?? ({} as EvolutionConfig);
  const config: EvolutionConfig = {
    populationSize: clamp(
      Math.round(Number(cfg.populationSize ?? 40)),
      10,
      150,
    ),
    eliteCount: clamp(Math.round(Number(cfg.eliteCount ?? 4)), 0, 20),
    mutationRate: clamp(Number(cfg.mutationRate ?? 0.06), 0, 0.5),
    mutationStrength: clamp(Number(cfg.mutationStrength ?? 1), 0.1, 3),
    crossoverRate: clamp(Number(cfg.crossoverRate ?? 0.9), 0, 1),
    tournamentSize: clamp(Math.round(Number(cfg.tournamentSize ?? 3)), 2, 8),
    evaluationSeconds: clamp(Number(cfg.evaluationSeconds ?? 12), 6, 20),
  };

  return {
    ok: true,
    warnings,
    experiment: {
      version: EXPERIMENT_VERSION,
      name: typeof obj.name === "string" ? obj.name : "Imported experiment",
      templateId: template.id,
      ranges,
      fitnessExpression: obj.fitnessExpression,
      terrainId,
      config,
    },
  };
}
