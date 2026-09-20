// Core types for Neural Lander. Plain data only (no planck, no DOM), so every
// config, episode, genome and result survives postMessage into the eval worker
// unchanged and can be re-simulated bit-for-bit on either side.

export type Vec = { x: number; y: number };

// ---------------------------------------------------------------- the rover

// Sensors are physical components. The network sees ONLY what these expose —
// there is no hidden state channel. Each sensor feeds 1–2 input neurons, all
// normalized into [-1, 1] or [0, 1] (see physics.ts for the exact mapping).
export type SensorSpec =
  | {
      id: string;
      kind: "range";
      label: string;
      x: number; // mount point, body frame (m)
      y: number;
      angle: number; // ray direction, body frame (rad, 0 = +x, -π/2 = down)
      maxDistance: number;
    }
  | { id: string; kind: "velocity"; label: string } // vx, vy (world frame)
  | { id: string; kind: "orientation"; label: string } // tilt from vertical
  | { id: string; kind: "angular-velocity"; label: string }
  | { id: string; kind: "fuel"; label: string }
  | { id: string; kind: "contact"; label: string; leg: "left" | "right" }
  | { id: string; kind: "beacon"; label: string }; // dx, dy to the pad

export type SensorKind = SensorSpec["kind"];

// `angle` is the direction the thruster PUSHES the rover, in the body frame.
// The flame points the opposite way. Torque falls out of where it's mounted:
// τ = r × F, with r measured from the body origin (≈ centre of mass).
export type ThrusterSpec = {
  id: string;
  label: string;
  x: number;
  y: number;
  angle: number;
  maxForce: number; // N at full throttle
  fuelRate: number; // fuel units / second at full throttle
};

export type LegSpec = { hip: Vec; foot: Vec };

export type RoverDesign = {
  id: string;
  label: string;
  blurb: string;
  hull: Vec[]; // convex polygon, body frame
  legs: { left: LegSpec; right: LegSpec };
  sensors: SensorSpec[];
  thrusters: ThrusterSpec[];
  fuelCapacity: number;
};

// ---------------------------------------------------------------- the world

export type PlanetConfig = {
  id: string;
  label: string;
  blurb: string;
  gravity: number; // m/s²
  drag: number; // linear damping (1/s) — a stand-in for atmosphere
  wind: number; // mean lateral push (m/s² of acceleration)
  gust: number; // amplitude of the slow sinusoidal gust on top
  roughness: number; // terrain amplitude (m)
  padHalfWidth: number; // m — keep it a multiple of GROUND_STEP
  sensorNoise: number; // σ of gaussian noise added to every normalized input
  spawnSpread: number; // ± m of horizontal spawn offset from the pad
};

// One concrete attempt: which terrain, where the pad is, how the rover spawns.
// Derived deterministically from a seed (episodes.ts), so the same seed is the
// same landing everywhere — main thread, worker, replay.
export type Episode = {
  seed: number;
  terrainSeed: number;
  padX: number;
  spawnDx: number; // spawn x relative to the pad
  spawnAltitude: number; // m above the pad
  vx0: number;
  vy0: number;
  angle0: number;
  windPhase: number;
};

// ---------------------------------------------------------------- the brain

export type Activation = "tanh" | "relu" | "sigmoid";

export type BrainLayout = {
  inputs: number;
  hidden: number;
  outputs: number;
  activation: Activation; // hidden layer; outputs are always clipped tanh
};

export type Genome = {
  id: number;
  generation: number;
  parentIds: number[];
  params: number[]; // W1 (hidden × inputs), b1, W2 (outputs × hidden), b2
};

// ---------------------------------------------------------------- results

export type FailureReason =
  | "hard-impact"
  | "excessive-horizontal-speed"
  | "excessive-tilt"
  | "tip-over"
  | "missed-zone"
  | "out-of-fuel"
  | "out-of-bounds"
  | "timeout";

export type Outcome = "landed" | FailureReason;

export type EpisodeResult = {
  outcome: Outcome;
  time: number; // s until the episode ended
  fuelUsed: number; // fraction of capacity, 0..1
  distance: number; // m from the pad surface at the end (0 = on it)
  endSpeed: number; // m/s — impact speed if it crashed
  endTilt: number; // |rad| from upright at the end
  touchdown: { vx: number; vy: number } | null; // first leg contact
  maxAltitude: number;
  finalX: number;
  finalY: number;
};

export type GenomeResult = {
  genome: Genome;
  episodes: EpisodeResult[];
  fitness: number;
  landed: number; // how many episodes ended in a landing
};

export type RewardWeights = {
  landing: number; // + once, for a safe landing on the pad
  touchdown: number; // + once, for coming to rest on its legs anywhere
  alive: number; // + per second the episode lasted
  fuel: number; // + per % of fuel left
  distance: number; // − per metre from the pad at the end
  impact: number; // − per m/s at the end (impact speed on a crash)
  tilt: number; // − per 10° of tilt at the end
  crash: number; // − once, for any crash
  outOfBounds: number; // − once, for leaving the arena
};

export type EvolutionConfig = {
  populationSize: number;
  eliteCount: number;
  mutationRate: number; // per-parameter probability of a nudge
  mutationSigma: number; // gaussian σ of that nudge
  crossoverRate: number; // probability a child mixes two parents
  tournamentSize: number;
  trainEpisodes: number; // episodes each genome is scored on
  maxSeconds: number; // episode timeout
};
