// Core types for the Evolution Sandbox. Framework-free; shared by the pure
// evolution engine, the Planck physics adapter, the templates, and the SVG view.
//
// The design deliberately reuses the "flat bag of named genes" trick from
// Evolving Vehicles / Creatures: a Genome is Record<string, number>, and a
// template's GeneSpec[] is the schema that gives each key a legal range, group,
// label, and display hint. Random / normalize / crossover / mutation / inspector
// are then tiny data-driven loops instead of per-field code — which is exactly
// what lets ONE engine drive several different bodies.

import type { FitnessMetrics, MetricName } from "./metrics.ts";
import type { World } from "planck";

export type Vec2 = { x: number; y: number };

export type Genome = Record<string, number>;

// A template author's static description of one gene: its HARD safety bounds
// (`min`/`max` — the physics stays sane anywhere in here), a sensible default,
// and how to present it. The user's editable search window (below) must stay
// inside these bounds.
export type GeneSpec = {
  key: string;
  group: string;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  unit?: string;
  display?: "num" | "pi"; // "pi" shows the value as a fraction of π (angles)
};

// The user-editable part: for each gene, the search window evolution samples and
// mutates within, whether it may mutate at all, and how hard. `min`/`max` here
// are clamped into the GeneSpec's hard bounds by the editor.
export type GeneRangeSetting = {
  min: number;
  max: number;
  mutable: boolean;
  mutationStrength: number; // gaussian sigma as a fraction of (max - min)
};

// A blueprint = a chosen template + the user's per-gene range settings. This is
// the "search space" the user designs. Structural editing (adding/removing
// parts) is intentionally out of scope for V1 — a blueprint only re-tunes the
// ranges of a fixed template.
export type Blueprint = {
  templateId: string;
  ranges: Record<string, GeneRangeSetting>;
};

export type EvolutionConfig = {
  populationSize: number;
  eliteCount: number;
  mutationRate: number; // per-gene probability of a nudge
  mutationStrength: number; // global multiplier on each gene's own strength
  crossoverRate: number;
  tournamentSize: number;
  evaluationSeconds: number;
};

// What one headless evaluation produces. `metrics` is the full vocabulary the
// fitness expression scored; `fitness` is that score; `breakdown` explains it.
export type SandboxEvaluationResult = {
  genome: Genome;
  fitness: number;
  metrics: FitnessMetrics;
  breakdown: FitnessBreakdownItem[];
};

export type FitnessBreakdownItem = {
  label: string; // the sub-expression, e.g. "distance * 10"
  value: number; // its signed contribution to the total
};

export type ChampionSnapshot = {
  generation: number;
  genome: Genome;
  fitness: number;
  metrics: FitnessMetrics;
  breakdown: FitnessBreakdownItem[];
  templateId: string;
  terrainId: string;
};

export type EvolutionHistoryPoint = {
  generation: number;
  bestFitness: number;
  averageFitness: number;
  bestDistance: number;
  averageDistance: number;
};

import type { Terrain, TerrainPoint } from "../../lib/terrain.ts";
export type { Terrain, TerrainPoint };

// ------------------------------------------------------------ render model
// A body-agnostic snapshot of one phenotype's pose, so the view can draw a
// rover, a crawler, or anything later without knowing what it is. Every physics
// body reports itself as a box or a circle; the view renders those directly.

export type RenderPart =
  | {
      kind: "box";
      x: number;
      y: number;
      angle: number;
      halfW: number;
      halfH: number;
      role: PartRole;
    }
  | {
      kind: "circle";
      x: number;
      y: number;
      angle: number;
      r: number;
      role: PartRole;
    };

export type PartRole = "body" | "wheel" | "limb" | "foot" | "tail";

export type PhenotypeRenderState = {
  parts: RenderPart[];
  joints: Vec2[]; // connection points, for the joint overlay
  com: Vec2; // whole-body center of mass
};

// ------------------------------------------------------------ template API
// A template knows how to turn a genome into physics bodies and drive them. Its
// instance exposes exactly what the shared sim / evaluator / view need — nothing
// template-specific leaks out.

export type PhenotypeInstance = {
  metrics: FitnessMetrics; // live; mutated in place as the sim runs
  finished: boolean;
  update(time: number): void; // drive motors + accumulate metrics for this step
  done(): boolean; // exploded / stuck / unstable — stop simulating it
  deactivate(): void; // cut motors once it's out of the running
  getRenderState(): PhenotypeRenderState;
  bodyX(): number; // root body x, for camera + leader tracking
};

export type Template = {
  id: string;
  label: string;
  subtitle: string;
  genes: GeneSpec[];
  geneGroups: string[]; // ordered; also the units of grouped crossover
  recommendedFitness: string; // a preset id from fitnessPresets.ts
  meaningfulMetrics: MetricName[]; // which metrics this body can actually move
  build(params: {
    world: World;
    genome: Genome;
    terrain: Terrain;
    groupIndex: number;
  }): PhenotypeInstance;
};

// ------------------------------------------------------------ experiment
export type SandboxExperiment = {
  version: number;
  name: string;
  templateId: string;
  ranges: Record<string, GeneRangeSetting>;
  fitnessExpression: string;
  terrainId: string;
  config: EvolutionConfig;
};
