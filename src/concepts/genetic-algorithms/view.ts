// SVG renderer for the maze world. Draws the fixed maze once, then each frame
// repositions a pool of agent dots and redraws the best-path trail. Talks to the
// engine only through `update(state)` / `dispose()`, mirroring gradient-descent's
// View contract so the orchestration code stays render-agnostic.

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
  dispose(): void;
};

export function createView(maze: Maze, reducedMotion: boolean): GAView {
  const width = PAD * 2 + maze.cols * CELL;
  const height = PAD * 2 + maze.rows * CELL;

  const cx = (col: number) => PAD + col * CELL + CELL / 2;
  const cy = (row: number) => PAD + row * CELL + CELL / 2;

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
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      const wall = isWall(maze, r, c);
      mazeLayer.append(
        svg("rect", {
          x: PAD + c * CELL + 1,
          y: PAD + r * CELL + 1,
          width: CELL - 2,
          height: CELL - 2,
          rx: 4,
          class: wall ? "ga-cell ga-cell--wall" : "ga-cell",
        }),
      );
    }
  }

  // start marker (square outline + label — never color alone)
  const start = svg("g", { class: "ga-start" });
  start.append(
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
  const target = svg("g", { class: "ga-target" });
  const targetRing = svg("circle", {
    cx: cx(maze.target.col),
    cy: cy(maze.target.row),
    r: CELL / 2 - 6,
    class: reducedMotion ? "ga-target-ring ga-target-ring--static" : "ga-target-ring",
  });
  target.append(
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
  const agentLayer = svg("g", { class: reducedMotion ? "ga-agents ga-agents--static" : "ga-agents" });

  root.append(mazeLayer, bestPathLine, start, target, agentLayer);

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
    dispose() {
      pool.length = 0;
      root.replaceChildren();
    },
  };
}
