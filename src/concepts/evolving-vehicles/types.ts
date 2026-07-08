// Core types for the Evolving Vehicles exhibit. Framework-free; shared by the
// pure evolution engine, the Planck physics adapter, and the SVG view.

export type Vec2 = { x: number; y: number };

// The genome is a flat bag of named numeric genes (see genome.ts for the schema
// that defines each one's range and grouping). Flat-and-schema-driven keeps
// random/normalize/crossover/mutate/inspector all tiny and data-driven instead
// of hand-writing per-field code for a nested struct.
export type GeneKey =
  | "chassisWidth"
  | "chassisHeight"
  | "chassisFrontScale"
  | "chassisRearScale"
  | "frontWheelRadius"
  | "rearWheelRadius"
  | "frontWheelX"
  | "rearWheelX"
  | "frontMotorTorque"
  | "rearMotorTorque"
  | "frontSuspension"
  | "rearSuspension";

export type VehicleGenome = Record<GeneKey, number>;

export type EvolutionConfig = {
  populationSize: number;
  eliteCount: number;
  mutationRate: number; // per-gene probability of a nudge
  mutationStrength: number; // gaussian sigma, in fraction of each gene's range
  crossoverRate: number; // probability two parents cross vs. clone the fitter
  tournamentSize: number;
  evaluationSeconds: number;
};

// What one headless evaluation measures. `maxX` (not finalX) drives distance so
// a car that lunges then rolls back still keeps credit for its best reach.
export type VehicleEvaluationResult = {
  genome: VehicleGenome;
  fitness: number;
  maxX: number;
  finalX: number;
  averageVelocityX: number;
  timeAlive: number;
  flipped: boolean;
  stuckSeconds: number;
  motorEnergy: number;
  chassisContactSeconds: number;
};

export type ChampionSnapshot = {
  generation: number;
  genome: VehicleGenome;
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
};

export type { Terrain, TerrainPoint } from "../../lib/terrain.ts";
