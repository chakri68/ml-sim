// Body-agnostic SVG viewport, copied from the Evolution Sandbox. It draws whatever
// parts a phenotype reports (boxes as rotated polygons, circles with a spoke so
// spin reads), plus terrain, distance markers, a start line, and ghost/trail paths,
// with the camera following the leader. Crucially it reconciles a phenotype's child
// elements only when the part-KIND sequence changes — which is exactly what a
// heterogeneous, structurally-varying crowd needs, so a two-legged and a six-legged
// body can share the pool. Reuses the global `es-*` styles.

import { svg } from "../../lib/dom.ts";
import { rollTerrainSigns, type TerrainSign } from "../../lib/signs.ts";
import { sampleTerrain, terrainHeight } from "./terrain.ts";
import type { RenderPart, Terrain, Vec2 } from "./types.ts";
import type { PopulationRenderItem } from "./physics.ts";

const VW = 940;
const VH = 440;
const PPM = 26;
const GROUND_SCREEN_Y = VH * 0.62;
const CAMERA_LEAD = 0.34;

export type MorphView = {
  el: SVGSVGElement;
  setTerrain(terrain: Terrain): void;
  rollDecor(): void;
  render(params: {
    items: PopulationRenderItem[];
    focusX: number;
    trail?: Vec2[];
    ghost?: Vec2[];
    showJoints: boolean;
    showCoM: boolean;
  }): void;
  dispose(): void;
};

type PartGfx =
  | { kind: "box"; el: SVGPolygonElement }
  | { kind: "circle"; el: SVGCircleElement; spoke: SVGLineElement };
type PhenoGfx = {
  g: SVGGElement;
  parts: PartGfx[];
  joints: SVGCircleElement[];
  com: SVGCircleElement;
};

export function createMorphView(): MorphView {
  const root = svg("svg", {
    viewBox: `0 0 ${VW} ${VH}`,
    class: "es-scene",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label":
      "Physics viewport: a crowd of evolving morphologies on terrain",
  });

  const sky = svg("rect", { x: 0, y: 0, width: VW, height: VH, class: "es-sky" });
  const groundFill = svg("path", { class: "es-ground" });
  const groundLine = svg("polyline", { class: "es-ground-line" });
  const markers = svg("g", { class: "es-markers" });
  const decor = svg("g", { class: "es-decor" });
  const startLine = svg("line", { class: "es-startline" });
  const ghostPath = svg("polyline", { class: "es-ghost" });
  const trailPath = svg("polyline", { class: "es-trail" });
  const fleet = svg("g", { class: "es-fleet" });
  root.append(
    sky,
    groundFill,
    groundLine,
    markers,
    decor,
    startLine,
    ghostPath,
    trailPath,
    fleet,
  );

  let terrain: Terrain | null = null;
  let cameraX = 0;
  const pool: PhenoGfx[] = [];
  let signGfx: { x: number; angle: number; g: SVGGElement }[] = [];

  const sx = (wx: number) => (wx - cameraX) * PPM;
  const sy = (wy: number) => GROUND_SCREEN_Y - wy * PPM;

  function makePheno(): PhenoGfx {
    const g = svg("g", { class: "es-pheno" });
    const com = svg("circle", { r: 4, class: "es-com" });
    fleet.append(g);
    return { g, parts: [], joints: [], com };
  }
  function ensurePool(n: number) {
    while (pool.length < n) pool.push(makePheno());
  }

  function reconcileParts(gfx: PhenoGfx, parts: RenderPart[]) {
    const kindsMatch =
      gfx.parts.length === parts.length &&
      gfx.parts.every((p, i) => p.kind === parts[i].kind);
    if (!kindsMatch) {
      gfx.g.replaceChildren();
      gfx.parts = parts.map((p) => {
        if (p.kind === "box") {
          const el = svg("polygon", { class: `es-part es-part--${p.role}` });
          gfx.g.append(el);
          return { kind: "box", el };
        }
        const el = svg("circle", { class: `es-part es-part--${p.role}` });
        const spoke = svg("line", { class: "es-spoke" });
        gfx.g.append(el, spoke);
        return { kind: "circle", el, spoke };
      });
      gfx.joints = [];
      gfx.g.append(gfx.com);
    }
  }

  function drawPart(pg: PartGfx, part: RenderPart) {
    if (part.kind === "box" && pg.kind === "box") {
      const cos = Math.cos(part.angle);
      const sin = Math.sin(part.angle);
      const corners: Array<[number, number]> = [
        [-part.halfW, -part.halfH],
        [part.halfW, -part.halfH],
        [part.halfW, part.halfH],
        [-part.halfW, part.halfH],
      ];
      pg.el.setAttribute(
        "points",
        corners
          .map(
            ([lx, ly]) =>
              `${sx(part.x + lx * cos - ly * sin).toFixed(1)},${sy(part.y + lx * sin + ly * cos).toFixed(1)}`,
          )
          .join(" "),
      );
    } else if (part.kind === "circle" && pg.kind === "circle") {
      pg.el.setAttribute("cx", sx(part.x).toFixed(1));
      pg.el.setAttribute("cy", sy(part.y).toFixed(1));
      pg.el.setAttribute("r", String(part.r * PPM));
      const rx = part.x + Math.cos(part.angle) * part.r;
      const ry = part.y + Math.sin(part.angle) * part.r;
      pg.spoke.setAttribute("x1", sx(part.x).toFixed(1));
      pg.spoke.setAttribute("y1", sy(part.y).toFixed(1));
      pg.spoke.setAttribute("x2", sx(rx).toFixed(1));
      pg.spoke.setAttribute("y2", sy(ry).toFixed(1));
    }
  }

  function drawPheno(
    gfx: PhenoGfx,
    item: PopulationRenderItem,
    showJoints: boolean,
    showCoM: boolean,
  ) {
    const state = item.state;
    reconcileParts(gfx, state.parts);
    for (let i = 0; i < state.parts.length; i++)
      drawPart(gfx.parts[i], state.parts[i]);

    while (gfx.joints.length < state.joints.length) {
      const c = svg("circle", { r: 3, class: "es-joint" });
      gfx.g.append(c);
      gfx.joints.push(c);
    }
    for (let i = 0; i < gfx.joints.length; i++) {
      const j = gfx.joints[i];
      const pt = state.joints[i];
      if (showJoints && pt) {
        j.style.display = "";
        j.setAttribute("cx", sx(pt.x).toFixed(1));
        j.setAttribute("cy", sy(pt.y).toFixed(1));
      } else {
        j.style.display = "none";
      }
    }

    if (showCoM) {
      gfx.com.style.display = "";
      gfx.com.setAttribute("cx", sx(state.com.x).toFixed(1));
      gfx.com.setAttribute("cy", sy(state.com.y).toFixed(1));
    } else {
      gfx.com.style.display = "none";
    }

    gfx.g.setAttribute(
      "class",
      item.isLeader
        ? "es-pheno es-pheno--leader"
        : item.finished
          ? "es-pheno es-pheno--done"
          : "es-pheno",
    );
  }

  function setTerrain(t: Terrain) {
    terrain = t;
  }

  function makeSign(sign: TerrainSign): SVGGElement {
    const postPx = 34;
    const boardH = 20;
    const boardW = Math.max(44, sign.text.length * 7 + 14);
    const boardTop = -postPx - boardH;
    const g = svg("g", { class: "es-sign" });
    g.append(
      svg("line", { x1: 0, y1: 0, x2: 0, y2: -postPx, class: "es-sign-post" }),
      svg("rect", {
        x: -boardW / 2,
        y: boardTop,
        width: boardW,
        height: boardH,
        rx: 3,
        class: "es-sign-board",
      }),
      svg(
        "text",
        {
          x: 0,
          y: boardTop + boardH / 2,
          class: "es-sign-text",
          "text-anchor": "middle",
          "dominant-baseline": "central",
        },
        sign.text,
      ),
    );
    return g;
  }

  function rollDecor() {
    const signs = rollTerrainSigns();
    signGfx = signs.map((s) => ({ x: s.x, angle: s.angle, g: makeSign(s) }));
    decor.replaceChildren(...signGfx.map((s) => s.g));
  }

  function positionSigns() {
    if (!terrain) return;
    for (const s of signGfx) {
      const gy = terrainHeight(terrain, s.x);
      const deg = (s.angle * 180) / Math.PI;
      s.g.setAttribute(
        "transform",
        `translate(${sx(s.x).toFixed(1)} ${sy(gy).toFixed(1)}) rotate(${deg.toFixed(1)})`,
      );
    }
  }

  function drawTerrain() {
    if (!terrain) return;
    const leftW = cameraX - 2;
    const rightW = cameraX + VW / PPM + 2;
    const visible = sampleTerrain(terrain, leftW, rightW, 0.5);
    if (visible.length < 2) {
      groundFill.setAttribute("d", "");
      groundLine.setAttribute("points", "");
      markers.replaceChildren();
      return;
    }
    const line = visible.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`);
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
      const gy = terrainHeight(terrain, mx);
      marks.push(
        svg("line", {
          x1: sx(mx),
          y1: sy(gy),
          x2: sx(mx),
          y2: sy(gy) - 12,
          class: "es-marker-tick",
        }),
        svg(
          "text",
          {
            x: sx(mx),
            y: sy(gy) - 16,
            class: "es-marker-label",
            "text-anchor": "middle",
          },
          `${mx}m`,
        ),
      );
    }
    markers.replaceChildren(...marks);

    if (0 >= leftW && 0 <= rightW) {
      const gy = terrainHeight(terrain, 0);
      startLine.style.display = "";
      startLine.setAttribute("x1", String(sx(0)));
      startLine.setAttribute("y1", String(sy(gy)));
      startLine.setAttribute("x2", String(sx(0)));
      startLine.setAttribute("y2", String(sy(gy) - 70));
    } else {
      startLine.style.display = "none";
    }
  }

  function drawPolyPath(elm: SVGPolylineElement, pts: Vec2[] | undefined) {
    if (!pts || pts.length < 2) {
      elm.setAttribute("points", "");
      return;
    }
    elm.setAttribute(
      "points",
      pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" "),
    );
  }

  function render(params: {
    items: PopulationRenderItem[];
    focusX: number;
    trail?: Vec2[];
    ghost?: Vec2[];
    showJoints: boolean;
    showCoM: boolean;
  }) {
    cameraX = params.focusX - (VW / PPM) * CAMERA_LEAD;
    drawTerrain();
    positionSigns();
    drawPolyPath(ghostPath, params.ghost);
    drawPolyPath(trailPath, params.trail);

    ensurePool(params.items.length);
    const order = params.items
      .map((_, i) => i)
      .sort(
        (a, b) =>
          Number(params.items[a].isLeader) - Number(params.items[b].isLeader),
      );
    let k = 0;
    for (const idx of order) {
      drawPheno(pool[k], params.items[idx], params.showJoints, params.showCoM);
      pool[k].g.style.display = "";
      k++;
    }
    for (let i = k; i < pool.length; i++) pool[i].g.style.display = "none";
  }

  return {
    el: root,
    setTerrain,
    rollDecor,
    render,
    dispose() {
      pool.length = 0;
      root.replaceChildren();
    },
  };
}
