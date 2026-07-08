// SVG viewport for the live race: terrain, the whole population of vehicles
// (chassis polygon + spinning wheels each), distance markers, a start line, and
// ghost/trail paths. The camera follows the leader horizontally, keeping it
// left-of-centre so upcoming terrain is visible. Vehicle graphics are pooled and
// reused across frames. Stateless-ish: the engine hands it what to draw.

import { svg } from "../../lib/dom.ts";
import { sampleTerrain, terrainHeight } from "./terrain.ts";
import type { Terrain } from "./types.ts";
import type { PopulationRenderItem } from "./physics.ts";

const VW = 920;
const VH = 440;
const PPM = 26;
const GROUND_SCREEN_Y = VH * 0.6;
const CAMERA_LEAD = 0.32;

type Pt = { x: number; y: number };

export type VehicleView = {
  el: SVGSVGElement;
  setTerrain(terrain: Terrain): void;
  render(params: {
    vehicles: PopulationRenderItem[];
    focusX: number;
    trail?: Pt[];
    ghost?: Pt[];
  }): void;
  dispose(): void;
};

type VehicleGfx = {
  g: SVGGElement;
  chassis: SVGPolygonElement;
  front: { tyre: SVGCircleElement; spoke: SVGLineElement };
  rear: { tyre: SVGCircleElement; spoke: SVGLineElement };
};

export function createVehicleView(): VehicleView {
  const root = svg("svg", {
    viewBox: `0 0 ${VW} ${VH}`,
    class: "ev-scene",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label":
      "Physics viewport: a population of vehicles driving across terrain",
  });

  const sky = svg("rect", {
    x: 0,
    y: 0,
    width: VW,
    height: VH,
    class: "ev-sky",
  });
  const groundFill = svg("path", { class: "ev-ground" });
  const groundLine = svg("polyline", { class: "ev-ground-line" });
  const markers = svg("g", { class: "ev-markers" });
  const startLine = svg("line", { class: "ev-startline" });
  const ghostPath = svg("polyline", { class: "ev-ghost" });
  const trailPath = svg("polyline", { class: "ev-trail" });
  const fleet = svg("g", { class: "ev-fleet" });

  root.append(
    sky,
    groundFill,
    groundLine,
    markers,
    startLine,
    ghostPath,
    trailPath,
    fleet,
  );

  let terrain: Terrain | null = null;
  let cameraX = 0;
  const pool: VehicleGfx[] = [];

  const sx = (wx: number) => (wx - cameraX) * PPM;
  const sy = (wy: number) => GROUND_SCREEN_Y - wy * PPM;

  function makeGfx(): VehicleGfx {
    const chassis = svg("polygon", { class: "ev-chassis" });
    const front = {
      tyre: svg("circle", { class: "ev-wheel" }),
      spoke: svg("line", { class: "ev-spoke" }),
    };
    const rear = {
      tyre: svg("circle", { class: "ev-wheel" }),
      spoke: svg("line", { class: "ev-spoke" }),
    };
    const g = svg(
      "g",
      {},
      rear.tyre,
      rear.spoke,
      front.tyre,
      front.spoke,
      chassis,
    );
    fleet.append(g);
    return { g, chassis, front, rear };
  }
  function ensurePool(n: number) {
    while (pool.length < n) pool.push(makeGfx());
  }

  function setTerrain(t: Terrain) {
    terrain = t;
  }

  function groundYAt(x: number): number {
    if (!terrain) return 0;
    return terrainHeight(terrain, x);
  }

  function drawTerrain() {
    if (!terrain) return;
    // Sample only the visible window, so the ground scrolls infinitely.
    const leftW = cameraX - 2;
    const rightW = cameraX + VW / PPM + 2;
    const visible = sampleTerrain(terrain, leftW, rightW, 0.5);
    if (visible.length < 2) {
      groundFill.setAttribute("d", "");
      groundLine.setAttribute("points", "");
      markers.replaceChildren();
      return;
    }
    const line = visible.map(
      (p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`,
    );
    groundLine.setAttribute("points", line.join(" "));
    const first = visible[0];
    const last = visible[visible.length - 1];
    groundFill.setAttribute(
      "d",
      `M ${sx(first.x).toFixed(1)} ${VH} L ${line.join(" L ")} L ${sx(last.x).toFixed(1)} ${VH} Z`,
    );

    const marks: SVGElement[] = [];
    const startM = Math.max(0, Math.ceil(leftW / 5) * 5);
    for (let mx = startM; mx <= rightW; mx += 5) {
      const gy = groundYAt(mx);
      marks.push(
        svg("line", {
          x1: sx(mx),
          y1: sy(gy),
          x2: sx(mx),
          y2: sy(gy) - 12,
          class: "ev-marker-tick",
        }),
        svg(
          "text",
          {
            x: sx(mx),
            y: sy(gy) - 16,
            class: "ev-marker-label",
            "text-anchor": "middle",
          },
          `${mx}m`,
        ),
      );
    }
    markers.replaceChildren(...marks);

    if (0 >= leftW && 0 <= rightW) {
      startLine.style.display = "";
      startLine.setAttribute("x1", String(sx(0)));
      startLine.setAttribute("y1", String(sy(groundYAt(0))));
      startLine.setAttribute("x2", String(sx(0)));
      startLine.setAttribute("y2", String(sy(groundYAt(0)) - 60));
    } else {
      startLine.style.display = "none";
    }
  }

  function drawPolyPath(el: SVGPolylineElement, pts: Pt[] | undefined) {
    if (!pts || pts.length < 2) {
      el.setAttribute("points", "");
      return;
    }
    el.setAttribute(
      "points",
      pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" "),
    );
  }

  function drawVehicle(gfx: VehicleGfx, item: PopulationRenderItem) {
    const v = item.state;
    const { x, y, angle } = v.chassis;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    gfx.chassis.setAttribute(
      "points",
      v.chassisVerts
        .map(
          (lv) =>
            `${sx(x + lv.x * cos - lv.y * sin).toFixed(1)},${sy(y + lv.x * sin + lv.y * cos).toFixed(1)}`,
        )
        .join(" "),
    );
    for (const [w, wheel] of [
      [v.frontWheel, gfx.front],
      [v.rearWheel, gfx.rear],
    ] as const) {
      const cxp = sx(w.x);
      const cyp = sy(w.y);
      const r = w.radius * PPM;
      wheel.tyre.setAttribute("cx", String(cxp));
      wheel.tyre.setAttribute("cy", String(cyp));
      wheel.tyre.setAttribute("r", String(r));
      wheel.spoke.setAttribute("x1", String(cxp));
      wheel.spoke.setAttribute("y1", String(cyp));
      wheel.spoke.setAttribute("x2", String(cxp + Math.cos(w.angle) * r));
      wheel.spoke.setAttribute("y2", String(cyp - Math.sin(w.angle) * r));
    }
    const cls = item.isLeader
      ? "ev-vehicle ev-vehicle--leader"
      : item.finished
        ? "ev-vehicle ev-vehicle--done"
        : "ev-vehicle";
    gfx.g.setAttribute("class", cls);
  }

  function render(params: {
    vehicles: PopulationRenderItem[];
    focusX: number;
    trail?: Pt[];
    ghost?: Pt[];
  }) {
    cameraX = params.focusX - (VW / PPM) * CAMERA_LEAD;
    drawTerrain();
    drawPolyPath(ghostPath, params.ghost);
    drawPolyPath(trailPath, params.trail);

    ensurePool(params.vehicles.length);
    // draw the leader last so it sits on top
    const order = params.vehicles
      .map((_, i) => i)
      .sort(
        (a, b) =>
          Number(params.vehicles[a].isLeader) -
          Number(params.vehicles[b].isLeader),
      );
    let k = 0;
    for (const idx of order) {
      drawVehicle(pool[k], params.vehicles[idx]);
      pool[k].g.style.display = "";
      k++;
    }
    for (let i = k; i < pool.length; i++) pool[i].g.style.display = "none";
  }

  return {
    el: root,
    setTerrain,
    render,
    dispose() {
      pool.length = 0;
      root.replaceChildren();
    },
  };
}
