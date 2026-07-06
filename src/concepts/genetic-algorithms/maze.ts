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
