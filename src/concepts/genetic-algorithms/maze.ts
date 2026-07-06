// A fixed hand-authored maze (no procedural generation in V1). BFS-verified
// solvable with an optimal path of 24 steps, so the default genome length (90)
// leaves plenty of slack for evolution to find and then shorten a route.
//
//   S = start   T = target   # = wall   . = empty

import type { GridPoint, Maze } from "./types.ts";

const LAYOUT = [
  "S....#....",
  ".###.#.##.",
  "...#...##.",
  "##.#.##.#.",
  ".....#..#.",
  ".###.#.#..",
  "...#.#.#.#",
  "#.##.#...#",
  "..#..###.#",
  ".#....#..T",
];

function parse(layout: string[]): Maze {
  const rows = layout.length;
  const cols = layout[0].length;
  const walls = new Set<string>();
  let start: GridPoint = { row: 0, col: 0 };
  let target: GridPoint = { row: rows - 1, col: cols - 1 };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = layout[r][c];
      if (ch === "#") walls.add(key(r, c));
      else if (ch === "S") start = { row: r, col: c };
      else if (ch === "T") target = { row: r, col: c };
    }
  }
  return { rows, cols, start, target, walls };
}

export function key(row: number, col: number): string {
  return `${row},${col}`;
}

export const defaultMaze: Maze = parse(LAYOUT);

export function isWall(maze: Maze, row: number, col: number): boolean {
  return maze.walls.has(key(row, col));
}

export function inBounds(maze: Maze, row: number, col: number): boolean {
  return row >= 0 && col >= 0 && row < maze.rows && col < maze.cols;
}

// A cell an agent may legally occupy: on the grid and not a wall.
export function isOpen(maze: Maze, row: number, col: number): boolean {
  return inBounds(maze, row, col) && !isWall(maze, row, col);
}

export function manhattan(a: GridPoint, b: GridPoint): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

// Upper bound on manhattan distance in this maze — used to turn "distance to
// target" into a reward that grows as agents get closer (see ga.ts).
export function maxDistance(maze: Maze): number {
  return maze.rows + maze.cols;
}

// BFS from start to target. Returns the shortest path length in steps, or -1 if
// the target is walled off. Used to guarantee generated/edited mazes are
// actually solvable (and hard enough to be interesting).
export function shortestPath(maze: Maze): number {
  const { start, target } = maze;
  const queue: Array<[number, number, number]> = [[start.row, start.col, 0]];
  const seen = new Set<string>([key(start.row, start.col)]);
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (let head = 0; head < queue.length; head++) {
    const [r, c, d] = queue[head];
    if (r === target.row && c === target.col) return d;
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (!isOpen(maze, nr, nc)) continue;
      const k = key(nr, nc);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push([nr, nc, d + 1]);
    }
  }
  return -1;
}

export function isSolvable(maze: Maze): boolean {
  return shortestPath(maze) >= 0;
}

// Return a copy of the maze with the wall at (row, col) set or cleared. Start and
// target cells can never become walls. Immutable so callers can swap it in.
export function withWall(
  maze: Maze,
  row: number,
  col: number,
  wall: boolean,
): Maze {
  if (
    (row === maze.start.row && col === maze.start.col) ||
    (row === maze.target.row && col === maze.target.col)
  ) {
    return maze;
  }
  const walls = new Set(maze.walls);
  if (wall) walls.add(key(row, col));
  else walls.delete(key(row, col));
  return { ...maze, walls };
}

// Generate a random maze on the same grid: scatter walls, then keep only layouts
// that BFS-verify solvable AND need at least `minPath` steps, so we never hand
// the population a trivial straight shot. Falls back to the default maze if the
// dice are unkind after `attempts` tries.
export function randomMaze(options?: {
  wallProbability?: number;
  minPath?: number;
  attempts?: number;
}): Maze {
  const rows = defaultMaze.rows;
  const cols = defaultMaze.cols;
  const start = defaultMaze.start;
  const target = defaultMaze.target;
  const wallProbability = options?.wallProbability ?? 0.3;
  const minPath = options?.minPath ?? Math.round((rows + cols) * 0.9);
  const attempts = options?.attempts ?? 300;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const walls = new Set<string>();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === start.row && c === start.col) continue;
        if (r === target.row && c === target.col) continue;
        if (Math.random() < wallProbability) walls.add(key(r, c));
      }
    }
    const candidate: Maze = { rows, cols, start, target, walls };
    if (shortestPath(candidate) >= minPath) return candidate;
  }
  return defaultMaze;
}
