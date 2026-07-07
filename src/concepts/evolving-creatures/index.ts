// Lightweight concept entry: metadata + a cheap animated card preview (a little
// two-legged creature stepping along), with the heavy engine (planck physics)
// lazy-loaded only when the page opens — so the homepage bundle never pulls in
// the physics library.

import { el } from "../../lib/dom.ts";
import { fadeIn } from "../../lib/transition.ts";
import type { Concept } from "../types.ts";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function mount(root: HTMLElement): () => void {
  let realCleanup: (() => void) | null = null;
  let cancelled = false;
  let raf = 0;

  root.replaceChildren(
    el(
      "div",
      { class: "gd-loading" },
      el("div", { class: "gd-loading-dots" }, "◔ ◑ ◕"),
      el("p", {}, "Loading physics…"),
    ),
  );

  import("./engine.ts").then(({ mount: engineMount }) => {
    if (cancelled) return;
    realCleanup = engineMount(root);
    if (reducedMotion) return;
    root.style.opacity = "0";
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        root.style.opacity = "";
        if (!cancelled) fadeIn(root);
      });
    });
  });

  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    root.style.opacity = "";
    realCleanup?.();
  };
}

export const evolvingCreatures: Concept = {
  id: "evolving-creatures",
  title: "Evolving Creatures",
  subtitle: "Watch bodies and movement patterns evolve into strange locomotion.",
  description:
    "An advanced genetic algorithm where a genome encodes both a creature's body and the rhythmic sine-wave motors driving its joints. A whole population is dropped into a 2D physics world and scored on how well it moves; selection, crossover, and mutation evolve morphology and gait together, until accidental flailing becomes something that genuinely crawls.",
  difficulty: "advanced",
  tags: ["genetic algorithms", "evolution", "physics", "locomotion", "artificial life"],
  route: "evolving-creatures",
  mount,
  preview(root) {
    const NS = "http://www.w3.org/2000/svg";
    const groundY = 34;

    const ground = document.createElementNS(NS, "line");
    ground.setAttribute("x1", "0");
    ground.setAttribute("y1", String(groundY));
    ground.setAttribute("x2", "60");
    ground.setAttribute("y2", String(groundY));
    ground.setAttribute("class", "card-curve");
    root.append(ground);

    const body = document.createElementNS(NS, "rect");
    body.setAttribute("width", "12");
    body.setAttribute("height", "4");
    body.setAttribute("rx", "1.4");
    body.setAttribute("class", "card-dot");
    const legs = [document.createElementNS(NS, "polyline"), document.createElementNS(NS, "polyline")];
    for (const leg of legs) {
      leg.setAttribute("class", "card-curve");
      leg.setAttribute("fill", "none");
      root.append(leg);
    }
    root.append(body);

    // Two limbs at ±4 from the body centre; knees/feet flex on a sine so it looks
    // like it's stepping. The whole thing drifts slowly right, then wraps.
    const place = (cx: number, t: number) => {
      const bodyY = groundY - 11;
      body.setAttribute("x", (cx - 6).toFixed(1));
      body.setAttribute("y", bodyY.toFixed(1));
      legs.forEach((leg, i) => {
        const sign = i === 0 ? 1 : -1;
        const hipX = cx + sign * 4;
        const phase = t + (i === 0 ? 0 : Math.PI);
        const kneeX = hipX + Math.sin(phase) * 2.2;
        const footX = hipX + Math.sin(phase) * 3.6;
        const footY = groundY - Math.max(0, Math.cos(phase)) * 3;
        leg.setAttribute(
          "points",
          `${hipX.toFixed(1)},${(bodyY + 4).toFixed(1)} ${kneeX.toFixed(1)},${(groundY - 4).toFixed(1)} ${footX.toFixed(1)},${footY.toFixed(1)}`,
        );
      });
    };

    if (reducedMotion) {
      place(30, 0.6);
      return;
    }
    let t = 0;
    let cx = 12;
    const tick = () => {
      t += 0.12;
      cx += 0.16;
      if (cx > 48) cx = 12;
      place(cx, t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
