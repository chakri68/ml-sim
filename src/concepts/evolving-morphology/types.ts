// Core types for Evolving Morphology — the concept where *structure itself*
// evolves, not just numeric tunings. Where the Evolution Sandbox pins every
// genome to one fixed template (a flat bag of named genes), here the genome IS a
// BodyGraph: a data description of the body that the generic interpreter turns
// into physics, and that structural mutation can grow or prune. That is the whole
// point — evolution may add a limb, drop a wheel, or duplicate a leg, so no two
// individuals need share the same part list.
//
// The graph is deliberately a rooted TREE, not a general graph. A tree gives the
// three things design §19.1 asks of a valid body for free: exactly one root, every
// part connected, and no closed kinematic loops (over-constrained joints that make
// Box2D fight itself). Every non-root part hangs off exactly one parent by one
// joint. Creatures and vehicles both fit this shape — the existing crawler, rover
// and hybrid are already trees in disguise.

import type { FitnessMetrics, MetricName } from "./metrics.ts";

export type Vec2 = { x: number; y: number };

// Render roles double as physics hints (wheels use circle shapes, get their own
// contact bucket) and as CSS classes in the view.
export type PartRole = "body" | "wheel" | "limb" | "foot" | "tail";

export type PartShape =
  | { kind: "box"; halfW: number; halfH: number }
  | { kind: "circle"; r: number };

// How a joint is driven. `sine` is a position servo tracking amp·sin(ωt+φ) — the
// crawler gait. `wheel` is a continuous-rotation velocity motor. `none` is a rigid
// weld (a revolute pinned to a zero-width angle window).
export type MotorKind = "none" | "sine" | "wheel";

export type Motor = {
  kind: MotorKind;
  amp: number; // sine target amplitude (rad)
  phase: number; // sine phase offset (rad)
  freqMult: number; // multiple of the graph's base gait frequency
  speed: number; // wheel target angular speed (rad/s), signed
  torque: number; // 0..1 fraction of MAX_MOTOR_TORQUE
};

// A part's attachment to its parent. The joint sits at a single world point; we
// specify it as a local anchor on each body (jParent on the parent, jChild on the
// child) plus the child's absolute spawn angle. The interpreter's layout pass
// solves child center from: R(childAngle)·jChild + childCenter = jointWorld.
export type Attachment = {
  parentId: string;
  jParent: Vec2; // joint anchor in parent-local coords
  jChild: Vec2; // joint anchor in child-local coords
  angle: number; // child's spawn world angle (rad)
  lowerAngle: number; // revolute limit
  upperAngle: number; // revolute limit
  motor: Motor;
};

export type Part = {
  id: string;
  role: PartRole;
  shape: PartShape;
  density: number;
  friction: number;
  attach: Attachment | null; // null only for the single root part
};

// The genome. A flat part list (tree encoded via attach.parentId) plus one shared
// base gait frequency, so sine motors across the whole body march to a common clock
// and phase relationships mean something.
export type BodyGraph = {
  rootId: string;
  gaitFreq: number;
  parts: Part[];
};

// ------------------------------------------------------------ render model
// Body-agnostic pose snapshot, identical in shape to the sandbox's so the copied
// view can draw a two-legged crawler or a six-legged thing without knowing which.

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

export type PhenotypeRenderState = {
  parts: RenderPart[];
  joints: Vec2[];
  com: Vec2;
};

// What the interpreter hands the sim: a live, self-driving phenotype. Same
// contract as the sandbox's PhenotypeInstance so the population sim can drive a
// heterogeneous crowd uniformly.
export type PhenotypeInstance = {
  metrics: FitnessMetrics;
  finished: boolean;
  update(time: number): void;
  done(): boolean;
  deactivate(): void;
  getRenderState(): PhenotypeRenderState;
  bodyX(): number;
};

// ------------------------------------------------------------ evolution
// The genome is a flat bag of named numbers (same trick as the sandbox), and a
// GeneSpec table gives each key its legal range, group, label, and display hint.
// A `buildCrawlerGraph(genome)` derives the consistent BodyGraph tree from these
// numbers; the interpreter above turns that into physics.
//
// M3: the genome now carries its own STRUCTURE (`legCount`), so two individuals in
// one population can have different numbers of legs — which means different gene
// sets. `values` holds the numbers; the gene set for a genome is always
// `planGenes(genome.legCount)`. Structural mutation changes legCount (and adds or
// drops the corresponding value keys); numeric mutation jitters `values`.

export type Genome = {
  legCount: number;
  values: Record<string, number>;
};

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

export type EvolutionConfig = {
  populationSize: number;
  eliteCount: number;
  mutationRate: number; // per-gene probability of a gaussian nudge
  mutationStrength: number; // sigma as a fraction of each gene's (max - min)
  crossoverRate: number;
  tournamentSize: number;
  evaluationSeconds: number;
  structuralRate: number; // per-offspring probability of a structural mutation
};

export type EvaluationResult = {
  genome: Genome;
  fitness: number;
  metrics: FitnessMetrics;
};

export type ChampionSnapshot = {
  generation: number;
  genome: Genome; // carries its own legCount
  fitness: number;
  metrics: FitnessMetrics;
  terrainId: string;
};

export type HistoryPoint = {
  generation: number;
  bestFitness: number;
  averageFitness: number;
  bestDistance: number;
  averageDistance: number;
};

// One additive term of a fitness score, for the "why did this win" breakdown.
export type FitnessBreakdownItem = {
  label: string; // the sub-expression, e.g. "distance * 10"
  value: number; // its signed contribution to the total
};

import type { Terrain, TerrainPoint } from "../../lib/terrain.ts";
export type { Terrain, TerrainPoint, MetricName, FitnessMetrics };
