// SVG renderer for the maze world. Draws the maze once, then each frame
// repositions a pool of agent dots and redraws the best-path trail. Supports
// live maze edits (swap which cells are walls) and an edit mode that turns cell
// clicks into wall toggles. Talks to the engine only through its returned API,
// mirroring gradient-descent's View contract so orchestration stays render-agnostic.

import { svg } from "../../lib/dom.ts";
import { isWall } from "./maze.ts";
import type { GridPoint, Maze } from "./types.ts";

const PAD = 14;
const CELL = 44;
const AGENT_R = 7;

export type ViewState = {
  agents: { pos: GridPoint; reachedTarget: boolean; isBest: boolean }[];
  bestPath: GridPoint[] | null; // best genome discovered so far
  showAgents: boolean;
  showBestPath: boolean;
};

export type GAView = {
  el: SVGSVGElement;
  update(state: ViewState): void;
  setMaze(maze: Maze): void;
  setEditMode(editing: boolean): void;
  dispose(): void;
};

export function createView(
  maze: Maze,
  reducedMotion: boolean,
  opts?: { onCellClick?: (row: number, col: number) => void },
): GAView {
  const rows = maze.rows;
  const cols = maze.cols;
  const width = PAD * 2 + cols * CELL;
  const height = PAD * 2 + rows * CELL;

  const cx = (col: number) => PAD + col * CELL + CELL / 2;
  const cy = (row: number) => PAD + row * CELL + CELL / 2;
  const isStart = (r: number, c: number) =>
    r === maze.start.row && c === maze.start.col;
  const isTarget = (r: number, c: number) =>
    r === maze.target.row && c === maze.target.col;

  const root = svg("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "ga-scene",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label":
      "Maze with a start cell, a target cell, walls, and a population of agents trying to reach the target",
  });

  // --- static maze layer ---------------------------------------------------
  const mazeLayer = svg("g", { class: "ga-maze" });
  const cellRects: SVGRectElement[][] = [];
  for (let r = 0; r < rows; r++) {
    cellRects[r] = [];
    for (let c = 0; c < cols; c++) {
      const rect = svg("rect", {
        x: PAD + c * CELL + 1,
        y: PAD + r * CELL + 1,
        width: CELL - 2,
        height: CELL - 2,
        rx: 4,
        class: "ga-cell",
      });
      cellRects[r][c] = rect;
      mazeLayer.append(rect);
    }
  }

  function applyWalls(m: Maze) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (isStart(r, c) || isTarget(r, c)) {
          cellRects[r][c].setAttribute("class", "ga-cell");
          continue;
        }
        cellRects[r][c].setAttribute(
          "class",
          isWall(m, r, c) ? "ga-cell ga-cell--wall" : "ga-cell",
        );
      }
    }
  }
  applyWalls(maze);

  // start marker (dashed box + label — never color alone)
  const start = svg(
    "g",
    { class: "ga-start" },
    svg("rect", {
      x: PAD + maze.start.col * CELL + 4,
      y: PAD + maze.start.row * CELL + 4,
      width: CELL - 8,
      height: CELL - 8,
      rx: 5,
      class: "ga-start-box",
    }),
    svg(
      "text",
      {
        x: cx(maze.start.col),
        y: cy(maze.start.row),
        class: "ga-cell-label",
        "text-anchor": "middle",
        "dominant-baseline": "central",
      },
      "S",
    ),
  );

  // target marker (pulsing ring + label)
  const targetRing = svg("circle", {
    cx: cx(maze.target.col),
    cy: cy(maze.target.row),
    r: CELL / 2 - 6,
    class: reducedMotion
      ? "ga-target-ring ga-target-ring--static"
      : "ga-target-ring",
  });
  const target = svg(
    "g",
    { class: "ga-target" },
    targetRing,
    svg(
      "text",
      {
        x: cx(maze.target.col),
        y: cy(maze.target.row),
        class: "ga-cell-label",
        "text-anchor": "middle",
        "dominant-baseline": "central",
      },
      "T",
    ),
  );

  const bestPathLine = svg("polyline", { class: "ga-best-path" });
  const agentLayer = svg("g", {
    class: reducedMotion ? "ga-agents ga-agents--static" : "ga-agents",
  });

  root.append(mazeLayer, bestPathLine, start, target, agentLayer);

  // --- edit-mode cell clicks ----------------------------------------------
  // Map a pointer event to a grid cell via the SVG's coordinate transform, so it
  // stays correct regardless of how the responsive <svg> is scaled/letterboxed.
  if (opts?.onCellClick) {
    root.addEventListener("click", (event) => {
      if (!root.classList.contains("ga-scene--edit")) return;
      const ctm = root.getScreenCTM();
      if (!ctm) return;
      const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        ctm.inverse(),
      );
      const col = Math.floor((pt.x - PAD) / CELL);
      const row = Math.floor((pt.y - PAD) / CELL);
      if (row < 0 || col < 0 || row >= rows || col >= cols) return;
      opts.onCellClick!(row, col);
    });
  }

  // --- pooled agent dots ---------------------------------------------------
  const pool: SVGCircleElement[] = [];
  function ensurePool(n: number) {
    while (pool.length < n) {
      const dot = svg("circle", { r: AGENT_R, class: "ga-agent" });
      pool.push(dot);
      agentLayer.append(dot);
    }
  }

  function update(state: ViewState) {
    // best-path trail
    if (state.showBestPath && state.bestPath && state.bestPath.length > 1) {
      bestPathLine.setAttribute(
        "points",
        state.bestPath.map((p) => `${cx(p.col)},${cy(p.row)}`).join(" "),
      );
      bestPathLine.style.display = "";
    } else {
      bestPathLine.style.display = "none";
    }

    // agents
    if (!state.showAgents) {
      for (const dot of pool) dot.style.display = "none";
      return;
    }
    ensurePool(state.agents.length);
    for (let i = 0; i < pool.length; i++) {
      const dot = pool[i];
      const agent = state.agents[i];
      if (!agent) {
        dot.style.display = "none";
        continue;
      }
      dot.style.display = "";
      dot.setAttribute("cx", String(cx(agent.pos.col)));
      dot.setAttribute("cy", String(cy(agent.pos.row)));
      const cls = agent.isBest
        ? "ga-agent ga-agent--best"
        : agent.reachedTarget
          ? "ga-agent ga-agent--done"
          : "ga-agent";
      dot.setAttribute("class", cls);
    }
  }

  return {
    el: root,
    update,
    setMaze(m: Maze) {
      applyWalls(m);
    },
    setEditMode(editing: boolean) {
      root.classList.toggle("ga-scene--edit", editing);
    },
    dispose() {
      pool.length = 0;
      root.replaceChildren();
    },
  };
}
