// Core types for the Genetic Algorithms exhibit. Kept framework-free and shared
// by the pure engine (ga.ts), the maze model (maze.ts), and the SVG view.

export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";

export type GridPoint = { row: number; col: number };

// A genome is just an ordered list of moves the agent replays blindly.
export type Genome = Direction[];

// The outcome of walking one genome through the maze. `path` includes the start
// cell and one entry per executed move (an agent that hits a wall stays put, so
// consecutive entries can repeat). Rendering reads `path` by index to animate.
export type AgentResult = {
  genome: Genome;
  path: GridPoint[];
  finalPos: GridPoint;
  distance: number; // manhattan distance from finalPos to the target
  reachedTarget: boolean;
  reachedAtStep: number; // genes consumed when the target was first touched
  wallHits: number;
  stepsTaken: number; // moves that actually changed position
  fitness: number;
};

export type GAConfig = {
  populationSize: number;
  genomeLength: number;
  mutationRate: number;
  eliteCount: number;
  tournamentSize: number;
};

export type Maze = {
  rows: number;
  cols: number;
  start: GridPoint;
  target: GridPoint;
  walls: Set<string>; // keyed "row,col"
};

export type GenerationStats = {
  generation: number;
  bestFitness: number;
  averageFitness: number;
  bestDistance: number;
  reachedTargetCount: number;
  bestSteps: number | null; // steps of the shortest successful run, if any
};

export type FitnessHistoryPoint = {
  generation: number;
  bestFitness: number;
  averageFitness: number;
};
