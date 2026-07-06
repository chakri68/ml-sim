// The genetic algorithm — pure functions, no DOM and no rendering. This is the
// part worth testing and reusing: give it genomes and a maze, get back walked
// paths, fitness, and the next generation. engine.ts owns all the UI/animation.

import { isOpen, manhattan, maxDistance } from "./maze.ts";
import type {
  AgentResult,
  Direction,
  GAConfig,
  Genome,
  GridPoint,
  Maze,
} from "./types.ts";

const DIRECTIONS: Direction[] = ["UP", "DOWN", "LEFT", "RIGHT"];

const DELTA: Record<Direction, { dr: number; dc: number }> = {
  UP: { dr: -1, dc: 0 },
  DOWN: { dr: 1, dc: 0 },
  LEFT: { dr: 0, dc: -1 },
  RIGHT: { dr: 0, dc: 1 },
};

function randomInt(min: number, max: number): number {
  // inclusive-exclusive: [min, max)
  return min + Math.floor(Math.random() * (max - min));
}

export function randomGene(): Direction {
  return DIRECTIONS[randomInt(0, DIRECTIONS.length)];
}

export function createRandomGenome(length: number): Genome {
  const genome: Genome = new Array(length);
  for (let i = 0; i < length; i++) genome[i] = randomGene();
  return genome;
}

export function createInitialPopulation(config: GAConfig): Genome[] {
  return Array.from({ length: config.populationSize }, () =>
    createRandomGenome(config.genomeLength),
  );
}

// Walk one genome through the maze. A move into a wall or off-grid is blocked:
// the agent stays put and takes a wall hit, keeping it on screen and giving the
// fitness function something to penalize. Stops early once the target is hit.
export function simulateAgent(genome: Genome, maze: Maze): AgentResult {
  let pos: GridPoint = maze.start;
  const path: GridPoint[] = [pos];
  let wallHits = 0;
  let stepsTaken = 0;
  let reachedTarget = false;
  let reachedAtStep = genome.length;

  for (let i = 0; i < genome.length; i++) {
    const { dr, dc } = DELTA[genome[i]];
    const nr = pos.row + dr;
    const nc = pos.col + dc;
    if (isOpen(maze, nr, nc)) {
      pos = { row: nr, col: nc };
      stepsTaken++;
    } else {
      wallHits++;
    }
    path.push(pos);

    if (pos.row === maze.target.row && pos.col === maze.target.col) {
      reachedTarget = true;
      reachedAtStep = i + 1;
      break;
    }
  }

  const result: AgentResult = {
    genome,
    path,
    finalPos: pos,
    distance: manhattan(pos, maze.target),
    reachedTarget,
    reachedAtStep,
    wallHits,
    stepsTaken,
    fitness: 0,
  };
  result.fitness = evaluateFitness(result, maze, genome.length);
  return result;
}

// fitness = distanceScore + targetBonus + speedBonus - wallPenalty, clamped >= 0.
//
// distanceScore is LINEAR in closeness (maxDistance - distance), not 1/(d+1).
// The reciprocal version is nearly flat until an agent lands on the target, so
// selection is close to random early on and the population barely improves. A
// linear reward gives real selective pressure toward the target from step one —
// which is exactly the "they're slowly discovering a path" effect we want.
export function evaluateFitness(
  agent: AgentResult,
  maze: Maze,
  genomeLength: number,
): number {
  const distanceScore = maxDistance(maze) - agent.distance;
  const targetBonus = agent.reachedTarget ? maxDistance(maze) * 2 : 0;
  const speedBonus = agent.reachedTarget
    ? (genomeLength - agent.reachedAtStep) * 0.4
    : 0;
  const wallPenalty = agent.wallHits * 0.15;
  return Math.max(0, distanceScore + targetBonus + speedBonus - wallPenalty);
}

// Tournament selection: sample k agents, return the fittest. Simple, visual to
// explain, and robust to tiny/zero fitness values. Falls back to a uniform pick
// when every agent scored zero (nothing to discriminate on).
export function tournamentSelect(
  population: AgentResult[],
  size: number,
): AgentResult {
  let best: AgentResult | null = null;
  const k = Math.max(1, Math.min(size, population.length));
  for (let i = 0; i < k; i++) {
    const candidate = population[randomInt(0, population.length)];
    if (!best || candidate.fitness > best.fitness) best = candidate;
  }
  return best ?? population[randomInt(0, population.length)];
}

// Single-point crossover: child takes parent A up to a cut, parent B after it.
export function crossover(parentA: Genome, parentB: Genome): Genome {
  if (parentA.length < 2) return parentA.slice();
  const point = randomInt(1, parentA.length);
  return [...parentA.slice(0, point), ...parentB.slice(point)];
}

// Each gene has `mutationRate` chance of being replaced with a random direction.
export function mutate(genome: Genome, mutationRate: number): Genome {
  return genome.map((gene) =>
    Math.random() < mutationRate ? randomGene() : gene,
  );
}

// One full generational step: elitism preserves the top genomes untouched, then
// the rest of the population is filled with mutated crossover children of
// tournament-selected parents. Returns the next generation's genomes.
export function createNextGeneration(params: {
  population: AgentResult[];
  config: GAConfig;
}): Genome[] {
  const { population, config } = params;
  const sorted = [...population].sort((a, b) => b.fitness - a.fitness);

  // Clamp elitism so it can never swallow half the population (§edge cases):
  // too many elites and evolution stalls because few children get made.
  const eliteCount = Math.max(
    0,
    Math.min(config.eliteCount, Math.floor(config.populationSize / 2)),
  );

  const next: Genome[] = [];
  for (let i = 0; i < eliteCount && i < sorted.length; i++) {
    next.push(sorted[i].genome.slice());
  }
  while (next.length < config.populationSize) {
    const parentA = tournamentSelect(population, config.tournamentSize);
    const parentB = tournamentSelect(population, config.tournamentSize);
    const child = mutate(
      crossover(parentA.genome, parentB.genome),
      config.mutationRate,
    );
    next.push(child);
  }
  return next;
}
