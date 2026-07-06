// 1D view: the loss curve with a descending point, tangent, and trail, drawn in
// SVG. Implements the shared View interface.

import { svg } from "../../lib/dom.ts";
import { clamp, projector, type Bounds } from "../../lib/math.ts";
import type { FuncDef } from "./functions.ts";
import type { EngineState, View } from "./view.ts";

const WIDTH = 660;
const HEIGHT = 460;
const PAD = 40;
const MAX_TRAIL_POINTS = 80;
const TANGENT_HALF_WIDTH = 1.1;

function yRange(func: FuncDef): { yMin: number; yMax: number } {
  const [xMin, xMax] = func.domain[0];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const y = func.fn([xMin + ((xMax - xMin) * i) / 200]);
    if (!Number.isFinite(y)) continue;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  const pad = (hi - lo) * 0.08 || 1;
  return { yMin: lo - pad, yMax: hi + pad };
}

export function createView2D(func: FuncDef, reducedMotion: boolean): View {
  const [xMin, xMax] = func.domain[0];
  const { yMin, yMax } = yRange(func);
  const bounds: Bounds = { xMin, xMax, yMin, yMax };
  const p = projector(bounds, WIDTH, HEIGHT, PAD);

  const root = svg("svg", {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    class: "gd-scene",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": `Loss curve for ${func.label} with a descending point`,
  });

  const grid = svg("g", { class: "gd-grid" });
  for (let gx = Math.ceil(xMin); gx <= xMax; gx++) {
    const px = p.x(gx);
    grid.append(
      svg("line", {
        x1: px,
        y1: PAD,
        x2: px,
        y2: HEIGHT - PAD,
        class: "gd-gridline",
      }),
    );
  }
  for (let i = 0; i <= 6; i++) {
    const py = p.y(yMin + ((yMax - yMin) * i) / 6);
    grid.append(
      svg("line", {
        x1: PAD,
        y1: py,
        x2: WIDTH - PAD,
        y2: py,
        class: "gd-gridline",
      }),
    );
  }

  const samples: string[] = [];
  for (let i = 0; i <= 240; i++) {
    const x = xMin + ((xMax - xMin) * i) / 240;
    const y = func.fn([x]);
    if (Number.isFinite(y))
      samples.push(`${p.x(x).toFixed(1)},${p.y(y).toFixed(1)}`);
  }
  const curve = svg("polyline", {
    class: "gd-curve",
    points: samples.join(" "),
  });

  const minMarker = svg("g", { class: "gd-min" });
  if (func.minPoint) {
    const mx = func.minPoint[0];
    minMarker.append(
      svg("circle", {
        cx: p.x(mx),
        cy: p.y(func.fn([mx])),
        r: 5,
        class: "gd-min-dot",
      }),
      svg(
        "text",
        {
          x: p.x(mx),
          y: p.y(func.fn([mx])) - 12,
          class: "gd-min-label",
          "text-anchor": "middle",
        },
        "minimum",
      ),
    );
  }

  const trailLine = svg("polyline", { class: "gd-trail" });
  const tangent = svg("line", { class: "gd-tangent" });
  const dropline = svg("line", { class: "gd-dropline" });
  const point = svg("circle", {
    r: 8,
    class: reducedMotion ? "gd-point gd-point--static" : "gd-point",
  });
  const xLabel = svg("text", { class: "gd-x-label", "text-anchor": "middle" });

  root.append(
    grid,
    curve,
    minMarker,
    trailLine,
    dropline,
    tangent,
    point,
    xLabel,
  );

  function update(state: EngineState) {
    const x = state.pos[0];
    const gradient = state.gradient[0];
    const y = func.fn([x]);
    const px = clamp(p.x(x), PAD, WIDTH - PAD);
    const py = clamp(Number.isFinite(y) ? p.y(y) : PAD, PAD, HEIGHT - PAD);

    point.setAttribute("cx", String(px));
    point.setAttribute("cy", String(py));

    dropline.setAttribute("x1", String(px));
    dropline.setAttribute("y1", String(py));
    dropline.setAttribute("x2", String(px));
    dropline.setAttribute("y2", String(p.y(yMin)));

    xLabel.setAttribute("x", String(px));
    xLabel.setAttribute("y", String(p.y(yMin) + 20));
    xLabel.textContent = `x = ${x.toFixed(2)}`;

    const x1 = x - TANGENT_HALF_WIDTH;
    const x2 = x + TANGENT_HALF_WIDTH;
    tangent.setAttribute("x1", String(p.x(x1)));
    tangent.setAttribute("y1", String(p.y(y + gradient * (x1 - x))));
    tangent.setAttribute("x2", String(p.x(x2)));
    tangent.setAttribute("y2", String(p.y(y + gradient * (x2 - x))));

    const recent = state.trail.slice(-MAX_TRAIL_POINTS);
    trailLine.setAttribute(
      "points",
      recent
        .map(
          (t) => `${p.x(t[0]).toFixed(1)},${p.y(func.fn([t[0]])).toFixed(1)}`,
        )
        .join(" "),
    );
  }

  return {
    el: root as unknown as HTMLElement,
    update,
    dispose() {},
  };
}
