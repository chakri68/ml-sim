// Core types for the Evolving Creatures exhibit. Framework-free; shared by the
// pure evolution engine, the Planck physics adapter, and the SVG view.
//
// The creature is a fixed two-limbed crawler seen from the side. Its genome is a
// flat bag of named numeric genes (schema in genome.ts) rather than a nested
// struct — the same trick as Evolving Vehicles, so random / normalize / crossover
// / mutate / inspector are all tiny data-driven loops. "Front" and "rear" are the
// two limbs; in a side view they attach at different points along the body (a
// leading limb and a trailing limb), so they never overlap on screen.

export type Vec2 = { x: number; y: number };

export type GeneKey =
  // Body
  | "bodyWidth"
  | "bodyHeight"
  // Limb morphology — SHARED by both limbs (mirrored front/rear). Keeping the
  // shape symmetric shrinks the search space and keeps the interesting signal in
  // the motors: two identically-shaped limbs driven at different phases is what
  // produces a gait. Asymmetric bodies are a later extension.
  | "limbAttach"
  | "upperLen"
  | "lowerLen"
  | "thickness"
  // Shared gait tempo (one frequency for every joint keeps motion periodic and
  // gait-like, instead of four joints drifting in and out of phase)
  | "gaitFrequency"
  // Front motors (shoulder + knee): swing amplitude and timing offset per joint,
  // one torque budget for the limb
  | "frontShoulderAmp"
  | "frontShoulderPhase"
  | "frontKneeAmp"
  | "frontKneePhase"
  | "frontTorque"
  // Rear motors
  | "rearShoulderAmp"
  | "rearShoulderPhase"
  | "rearKneeAmp"
  | "rearKneePhase"
  | "rearTorque";

export type CreatureGenome = Record<GeneKey, number>;

export type EvolutionConfig = {
  populationSize: number;
  eliteCount: number;
  mutationRate: number; // per-gene probability of a nudge
  mutationStrength: number; // gaussian sigma, in fraction of each gene's range
  crossoverRate: number; // probability two parents cross vs. clone the fitter
  tournamentSize: number;
  evaluationSeconds: number;
};

// What one headless evaluation measures. `maxX` (not finalX) drives distance so a
// creature that lunges forward then falls back still keeps credit for its best
// reach. The penalty fields feed the fitness function's anti-cheese terms.
export type CreatureEvaluationResult = {
  genome: CreatureGenome;
  fitness: number;
  maxX: number;
  finalX: number;
  averageVelocityX: number;
  timeAlive: number;
  energyUsed: number;
  fellOver: boolean;
  bodyGroundContactSeconds: number; // body dragging on the ground
  excessiveRotationSeconds: number; // spinning-demon detector
  instabilityScore: number;
};

export type CreatureChampionSnapshot = {
  generation: number;
  genome: CreatureGenome;
  fitness: number;
  maxX: number;
  averageVelocityX: number;
  terrainId: string;
};

export type EvolutionHistoryPoint = {
  generation: number;
  bestFitness: number;
  averageFitness: number;
  bestDistance: number;
  averageDistance: number;
};

export type TerrainPoint = { x: number; y: number };

export type Terrain = {
  id: string;
  label: string;
  points: TerrainPoint[];
};
