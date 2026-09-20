// SVG viewport for the landing site: terrain, pad, the swarm of rovers with
// their thruster flames, trails, end-of-episode markers, the focused rover's
// sensor rays, and two small HUD blocks. The camera is fixed on the pad, so a
// converging population literally converges on screen.
//
// Rover geometry is built once per design in body-local pixels; each frame only
// moves a group transform and resizes the flames, which keeps a 100-rover swarm
// cheap. Clicking near a rover picks it for inspection.

import { svg } from "../../lib/dom.ts";
import { mulberry32 } from "./rng.ts";
import type { Ground } from "./terrain.ts";
import type { LanderRenderState } from "./physics.ts";
import type { Outcome, RoverDesign, Vec } from "./types.ts";

const VW = 960;
const VH = 640;
const PPM = 16; // pixels per metre → 60 m × 40 m of world
const FLOOR_M = 8; // metres of ground shown below the pad

export type RoverRole = "champion" | "elite" | "crowd";

export type RoverVisual = {
  state: LanderRenderState;
  role: RoverRole;
  focused: boolean;
  trail: Vec[];
  label?: string; // compare mode: which generation this is
};

export type LanderView = {
  el: SVGSVGElement;
  setGround(ground: Ground): void;
  setDesign(design: RoverDesign): void;
  render(params: {
    rovers: RoverVisual[];
    hud: string[];
    inspector: string[] | null;
    showTrails: boolean;
    showRays: boolean;
    showVelocity: boolean;
  }): void;
  banner(text: string): void;
  onPick(cb: (index: number) => void): void;
  dispose(): void;
};

type RoverGfx = {
  g: SVGGElement;
  body: SVGGElement;
  flames: SVGPolygonElement[];
  marker: SVGTextElement;
  label: SVGTextElement;
  trail: SVGPolylineElement;
};

const OUTCOME_GLYPH: Record<Outcome, string> = {
  landed: "✓",
  "missed-zone": "◇",
  timeout: "○",
  "out-of-bounds": "",
  "hard-impact": "×",
  "excessive-horizontal-speed": "×",
  "excessive-tilt": "×",
  "tip-over": "×",
  "out-of-fuel": "×",
};

export function createLanderView(): LanderView {
  const root = svg("svg", {
    viewBox: `0 0 ${VW} ${VH}`,
    class: "nl-scene",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": "Landing site: a population of neural-network rovers descending toward a pad",
  });

  const stars = svg("g", { class: "nl-stars" });
  {
    const rng = mulberry32(99);
    for (let i = 0; i < 70; i++)
      stars.append(
        svg("circle", {
          cx: (rng() * VW).toFixed(1),
          cy: (rng() * VH * 0.7).toFixed(1),
          r: (0.4 + rng() * 0.9).toFixed(2),
        }),
      );
  }
  const groundFill = svg("path", { class: "nl-ground" });
  const groundLine = svg("polyline", { class: "nl-ground-line" });
  const pad = svg("line", { class: "nl-pad" });
  const padPosts = svg("g", { class: "nl-pad-posts" });
  const trails = svg("g", { class: "nl-trails" });
  const rays = svg("g", { class: "nl-rays" });
  const fleet = svg("g", { class: "nl-fleet" });
  const vectors = svg("g", { class: "nl-vectors" });
  const markers = svg("g", { class: "nl-markers" });
  const hudText = svg("text", { class: "nl-hud", x: 14, y: 24 });
  const inspBg = svg("rect", { class: "nl-insp-bg", rx: 6 });
  const inspText = svg("text", { class: "nl-insp", x: VW - 14, y: 24, "text-anchor": "end" });
  // Bottom centre: the top corners already belong to the HUD and the inspector.
  const bannerText = svg("text", {
    class: "nl-banner",
    x: VW / 2,
    y: VH - 16,
    "text-anchor": "middle",
  });
  root.append(
    stars,
    groundFill,
    groundLine,
    pad,
    padPosts,
    trails,
    rays,
    fleet,
    vectors,
    markers,
    inspBg,
    inspText,
    hudText,
    bannerText,
  );

  let ground: Ground | null = null;
  let design: RoverDesign | null = null;
  let camX = 0; // world x at the left edge
  let camY = 0; // world y at the bottom edge
  const pool: RoverGfx[] = [];
  let pickCb: ((i: number) => void) | null = null;
  let lastRovers: RoverVisual[] = [];
  let bannerTimer = 0;

  const sx = (wx: number) => (wx - camX) * PPM;
  const sy = (wy: number) => VH - (wy - camY) * PPM;
  const lx = (bx: number) => bx * PPM; // body-local → local pixels
  const ly = (by: number) => -by * PPM;

  function buildBody(target: SVGGElement, flames: SVGPolygonElement[]) {
    target.replaceChildren();
    flames.length = 0;
    if (!design) return;
    for (let i = 0; i < design.thrusters.length; i++) {
      const f = svg("polygon", { class: "nl-flame" });
      flames.push(f);
      target.append(f);
    }
    for (const leg of [design.legs.left, design.legs.right]) {
      target.append(
        svg("line", {
          class: "nl-leg",
          x1: lx(leg.hip.x),
          y1: ly(leg.hip.y),
          x2: lx(leg.foot.x),
          y2: ly(leg.foot.y),
        }),
        svg("line", {
          class: "nl-footpad",
          x1: lx(leg.foot.x) - 4,
          y1: ly(leg.foot.y),
          x2: lx(leg.foot.x) + 4,
          y2: ly(leg.foot.y),
        }),
      );
    }
    target.append(
      svg("polygon", {
        class: "nl-hull",
        points: design.hull.map((v) => `${lx(v.x)},${ly(v.y)}`).join(" "),
      }),
    );
  }

  function makeGfx(): RoverGfx {
    const body = svg("g", {});
    const g = svg("g", { class: "nl-rover" }, body);
    const flames: SVGPolygonElement[] = [];
    buildBody(body, flames);
    const marker = svg("text", { class: "nl-marker", "text-anchor": "middle" });
    const label = svg("text", { class: "nl-label", "text-anchor": "middle" });
    const trail = svg("polyline", { class: "nl-trail" });
    fleet.append(g);
    markers.append(marker, label);
    trails.append(trail);
    return { g, body, flames, marker, label, trail };
  }

  function ensurePool(n: number) {
    while (pool.length < n) pool.push(makeGfx());
  }

  function setGround(g: Ground) {
    ground = g;
    camX = g.padX - VW / PPM / 2;
    camY = g.padY - FLOOR_M;
    const pts = g.points.filter((p) => p.x >= camX - 1 && p.x <= camX + VW / PPM + 1);
    const line = pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`);
    groundLine.setAttribute("points", line.join(" "));
    if (pts.length > 1)
      groundFill.setAttribute(
        "d",
        `M ${sx(pts[0].x).toFixed(1)} ${VH} L ${line.join(" L ")} L ${sx(pts[pts.length - 1].x).toFixed(1)} ${VH} Z`,
      );
    const l = g.padX - g.padHalfWidth;
    const r = g.padX + g.padHalfWidth;
    pad.setAttribute("x1", String(sx(l)));
    pad.setAttribute("x2", String(sx(r)));
    pad.setAttribute("y1", String(sy(g.padY)));
    pad.setAttribute("y2", String(sy(g.padY)));
    padPosts.replaceChildren(
      ...[l, r].flatMap((x) => [
        svg("line", { x1: sx(x), y1: sy(g.padY), x2: sx(x), y2: sy(g.padY) - 14 }),
        svg("circle", { cx: sx(x), cy: sy(g.padY) - 15, r: 2.2 }),
      ]),
    );
  }

  function setDesign(d: RoverDesign) {
    design = d;
    for (const gfx of pool) buildBody(gfx.body, gfx.flames);
  }

  function drawFlames(gfx: RoverGfx, throttle: number[]) {
    if (!design) return;
    design.thrusters.forEach((th, i) => {
      const f = gfx.flames[i];
      if (!f) return;
      const u = throttle[i] ?? 0;
      if (u <= 0.01) {
        f.setAttribute("points", "");
        return;
      }
      // flame points opposite the push, length scales with force
      const a = th.angle + Math.PI;
      const len = (0.35 + 1.4 * (th.maxForce / 65)) * u;
      const w = 0.16 + 0.12 * (th.maxForce / 65);
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      const px = -cy;
      const py = cx;
      const pts = [
        [th.x + px * w, th.y + py * w],
        [th.x + cx * len, th.y + cy * len],
        [th.x - px * w, th.y - py * w],
      ];
      f.setAttribute("points", pts.map(([x, y]) => `${lx(x).toFixed(1)},${ly(y).toFixed(1)}`).join(" "));
    });
  }

  function drawTrail(el: SVGPolylineElement, pts: Vec[], on: boolean) {
    if (!on || pts.length < 2) {
      el.setAttribute("points", "");
      return;
    }
    let s = "";
    for (const p of pts) s += `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)} `;
    el.setAttribute("points", s);
  }

  function setLines(target: SVGTextElement, lines: string[], x: number) {
    target.replaceChildren(
      ...lines.map((t, i) => svg("tspan", { x, dy: i === 0 ? 0 : 17 }, t)),
    );
  }

  function render(params: {
    rovers: RoverVisual[];
    hud: string[];
    inspector: string[] | null;
    showTrails: boolean;
    showRays: boolean;
    showVelocity: boolean;
  }) {
    lastRovers = params.rovers;
    ensurePool(params.rovers.length);
    const rayEls: SVGElement[] = [];
    const vecEls: SVGElement[] = [];

    // Draw order: crowd first, champion and focused rover on top.
    const rank = (v: RoverVisual) =>
      (v.focused ? 3 : 0) + (v.role === "champion" ? 2 : v.role === "elite" ? 1 : 0);
    const order = params.rovers.map((_, i) => i).sort((a, b) => rank(params.rovers[a]) - rank(params.rovers[b]));

    let k = 0;
    for (const idx of order) {
      const v = params.rovers[idx];
      const gfx = pool[k++];
      const s = v.state;
      const cls = ["nl-rover", `nl-rover--${v.role}`];
      if (v.focused) cls.push("nl-rover--focus");
      if (s.outcome) cls.push("nl-rover--done");
      gfx.g.setAttribute("class", cls.join(" "));
      gfx.g.style.display = "";
      gfx.g.setAttribute(
        "transform",
        `translate(${sx(s.x).toFixed(1)} ${sy(s.y).toFixed(1)}) rotate(${((-s.angle * 180) / Math.PI).toFixed(2)})`,
      );
      drawFlames(gfx, s.throttle);
      drawTrail(gfx.trail, v.trail, params.showTrails || v.focused);
      gfx.trail.setAttribute(
        "class",
        `nl-trail nl-trail--${v.role}${v.focused ? " nl-trail--focus" : ""}`,
      );

      const glyph = s.outcome ? OUTCOME_GLYPH[s.outcome] : "";
      gfx.marker.textContent = glyph;
      gfx.marker.setAttribute("x", sx(s.x).toFixed(1));
      gfx.marker.setAttribute("y", (sy(s.y) - 26).toFixed(1));
      gfx.marker.setAttribute(
        "class",
        `nl-marker${s.outcome === "landed" ? " nl-marker--ok" : ""}${v.focused ? " nl-marker--focus" : ""}`,
      );
      // Compare mode parks several champions on the same pad, so stagger the
      // labels down the screen instead of stacking them on one line.
      gfx.label.textContent = v.label ?? "";
      gfx.label.setAttribute("x", sx(s.x).toFixed(1));
      gfx.label.setAttribute("y", (sy(s.y) + 30 + (idx % 4) * 14).toFixed(1));

      if (v.focused && params.showRays) {
        for (const r of s.rays) {
          rayEls.push(
            svg("line", {
              class: r.hit ? "nl-ray nl-ray--hit" : "nl-ray",
              x1: sx(r.x1).toFixed(1),
              y1: sy(r.y1).toFixed(1),
              x2: sx(r.x2).toFixed(1),
              y2: sy(r.y2).toFixed(1),
            }),
          );
          if (r.hit)
            rayEls.push(svg("circle", { class: "nl-ray-hit", cx: sx(r.x2), cy: sy(r.y2), r: 2.5 }));
        }
      }
      if (params.showVelocity && (v.focused || v.role === "champion") && !s.outcome) {
        const x1 = sx(s.x);
        const y1 = sy(s.y);
        vecEls.push(
          svg("line", {
            class: "nl-vel",
            x1,
            y1,
            x2: (x1 + s.vx * PPM * 0.6).toFixed(1),
            y2: (y1 - s.vy * PPM * 0.6).toFixed(1),
          }),
        );
      }
    }
    for (let i = k; i < pool.length; i++) {
      pool[i].g.style.display = "none";
      pool[i].marker.textContent = "";
      pool[i].label.textContent = "";
      pool[i].trail.setAttribute("points", "");
    }
    rays.replaceChildren(...rayEls);
    vectors.replaceChildren(...vecEls);

    setLines(hudText, params.hud, 14);
    if (params.inspector) {
      setLines(inspText, params.inspector, VW - 14);
      inspBg.style.display = "";
      const h = params.inspector.length * 17 + 14;
      inspBg.setAttribute("x", String(VW - 268));
      inspBg.setAttribute("y", "8");
      inspBg.setAttribute("width", "260");
      inspBg.setAttribute("height", String(h));
    } else {
      inspText.replaceChildren();
      inspBg.style.display = "none";
    }
  }

  function banner(text: string) {
    bannerText.textContent = text;
    bannerText.classList.add("nl-banner--on");
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => bannerText.classList.remove("nl-banner--on"), 2600);
  }

  // Pick the rover nearest the click (within ~3 m), in world space.
  root.addEventListener("click", (e) => {
    if (!pickCb || !ground) return;
    const ctm = root.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const wx = p.x / PPM + camX;
    const wy = (VH - p.y) / PPM + camY;
    let best = -1;
    let bestD = 3;
    lastRovers.forEach((v, i) => {
      const d = Math.hypot(v.state.x - wx, v.state.y - wy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) pickCb(best);
  });

  return {
    el: root,
    setGround,
    setDesign,
    render,
    banner,
    onPick(cb) {
      pickCb = cb;
    },
    dispose() {
      window.clearTimeout(bannerTimer);
      pool.length = 0;
      root.replaceChildren();
    },
  };
}
