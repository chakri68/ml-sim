// SVG viewport for the live population: terrain, the whole population of crawlers
// (each a body box + two two-segment limbs), distance markers, a start line, and
// ghost/trail paths. The camera follows the leader horizontally, keeping it
// left-of-centre so upcoming ground is visible. Creature graphics are pooled and
// reused across frames. The engine hands it what to draw each frame.

import { svg } from "../../lib/dom.ts";
import { sampleTerrain, terrainHeight } from "./terrain.ts";
import type { Terrain } from "./types.ts";
import type { PopulationRenderItem } from "./physics.ts";

const VW = 920;
const VH = 440;
const PPM = 34; // creatures are small (~1-3 m); scale up so limbs are legible
const GROUND_SCREEN_Y = VH * 0.62;
const CAMERA_LEAD = 0.34;

type Pt = { x: number; y: number };

export type CreatureView = {
  el: SVGSVGElement;
  setTerrain(terrain: Terrain): void;
  render(params: {
    creatures: PopulationRenderItem[];
    focusX: number;
    trail?: Pt[];
    ghost?: Pt[];
    showJoints: boolean;
    showCoM: boolean;
  }): void;
  dispose(): void;
};

type CreatureGfx = {
  g: SVGGElement;
  body: SVGPolygonElement;
  limbs: [SVGPolylineElement, SVGPolylineElement];
  joints: SVGCircleElement[]; // 6: shoulder/knee/foot per limb
  com: SVGCircleElement;
};

export function createCreatureView(): CreatureView {
  const root = svg("svg", {
    viewBox: `0 0 ${VW} ${VH}`,
    class: "ec-scene",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label":
      "Physics viewport: a population of crawling creatures on terrain",
  });

  const sky = svg("rect", {
    x: 0,
    y: 0,
    width: VW,
    height: VH,
    class: "ec-sky",
  });
  const groundFill = svg("path", { class: "ec-ground" });
  const groundLine = svg("polyline", { class: "ec-ground-line" });
  const markers = svg("g", { class: "ec-markers" });
  const startLine = svg("line", { class: "ec-startline" });
  const ghostPath = svg("polyline", { class: "ec-ghost" });
  const trailPath = svg("polyline", { class: "ec-trail" });
  const fleet = svg("g", { class: "ec-fleet" });

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
  const pool: CreatureGfx[] = [];

  const sx = (wx: number) => (wx - cameraX) * PPM;
  const sy = (wy: number) => GROUND_SCREEN_Y - wy * PPM;

  function makeGfx(): CreatureGfx {
    const body = svg("polygon", { class: "ec-body" });
    const limbs: [SVGPolylineElement, SVGPolylineElement] = [
      svg("polyline", { class: "ec-limb" }),
      svg("polyline", { class: "ec-limb" }),
    ];
    const joints = Array.from({ length: 6 }, () =>
      svg("circle", { r: 2.6, class: "ec-joint" }),
    );
    const com = svg("circle", { r: 4, class: "ec-com" });
    const g = svg("g", {}, limbs[0], limbs[1], body, ...joints, com);
    fleet.append(g);
    return { g, body, limbs, joints, com };
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
          class: "ec-marker-tick",
        }),
        svg(
          "text",
          {
            x: sx(mx),
            y: sy(gy) - 16,
            class: "ec-marker-label",
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
      startLine.setAttribute("y2", String(sy(groundYAt(0)) - 70));
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

  function drawCreature(
    gfx: CreatureGfx,
    item: PopulationRenderItem,
    showJoints: boolean,
    showCoM: boolean,
  ) {
    const c = item.state;
    const b = c.body;
    const cos = Math.cos(b.angle);
    const sin = Math.sin(b.angle);
    const corners: Array<[number, number]> = [
      [-b.halfW, -b.halfH],
      [b.halfW, -b.halfH],
      [b.halfW, b.halfH],
      [-b.halfW, b.halfH],
    ];
    gfx.body.setAttribute(
      "points",
      corners
        .map(
          ([lx, ly]) =>
            `${sx(b.x + lx * cos - ly * sin).toFixed(1)},${sy(b.y + lx * sin + ly * cos).toFixed(1)}`,
        )
        .join(" "),
    );

    const strokeW = Math.max(2, c.thickness * PPM);
    let jointIdx = 0;
    for (let li = 0; li < 2; li++) {
      const limb = c.limbs[li];
      const line = gfx.limbs[li];
      line.setAttribute(
        "points",
        `${sx(limb.shoulder.x).toFixed(1)},${sy(limb.shoulder.y).toFixed(1)} ` +
          `${sx(limb.knee.x).toFixed(1)},${sy(limb.knee.y).toFixed(1)} ` +
          `${sx(limb.foot.x).toFixed(1)},${sy(limb.foot.y).toFixed(1)}`,
      );
      line.setAttribute("stroke-width", String(strokeW));
      for (const p of [limb.shoulder, limb.knee, limb.foot]) {
        const dot = gfx.joints[jointIdx++];
        if (showJoints) {
          dot.style.display = "";
          dot.setAttribute("cx", sx(p.x).toFixed(1));
          dot.setAttribute("cy", sy(p.y).toFixed(1));
        } else {
          dot.style.display = "none";
        }
      }
    }

    if (showCoM) {
      gfx.com.style.display = "";
      gfx.com.setAttribute("cx", sx(c.com.x).toFixed(1));
      gfx.com.setAttribute("cy", sy(c.com.y).toFixed(1));
    } else {
      gfx.com.style.display = "none";
    }

    const cls = item.isLeader
      ? "ec-creature ec-creature--leader"
      : item.finished
        ? "ec-creature ec-creature--done"
        : "ec-creature";
    gfx.g.setAttribute("class", cls);
  }

  function render(params: {
    creatures: PopulationRenderItem[];
    focusX: number;
    trail?: Pt[];
    ghost?: Pt[];
    showJoints: boolean;
    showCoM: boolean;
  }) {
    cameraX = params.focusX - (VW / PPM) * CAMERA_LEAD;
    drawTerrain();
    drawPolyPath(ghostPath, params.ghost);
    drawPolyPath(trailPath, params.trail);

    ensurePool(params.creatures.length);
    // draw the leader last so it sits on top of the grey crowd
    const order = params.creatures
      .map((_, i) => i)
      .sort(
        (a, b) =>
          Number(params.creatures[a].isLeader) -
          Number(params.creatures[b].isLeader),
      );
    let k = 0;
    for (const idx of order) {
      drawCreature(
        pool[k],
        params.creatures[idx],
        params.showJoints,
        params.showCoM,
      );
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
