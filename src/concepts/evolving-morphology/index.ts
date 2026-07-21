// Lightweight concept entry: metadata + a cheap animated card preview (a little
// many-legged crawler shuffling along), with the heavy engine (planck physics)
// lazy-loaded only when the page opens — so the homepage bundle never pulls in the
// physics library.

import { el } from "../../lib/dom.ts";
import { fadeIn } from "../../lib/transition.ts";
import type { Concept } from "../types.ts";

const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

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

export const evolvingMorphology: Concept = {
  id: "evolving-morphology",
  title: "Evolving Morphology",
  subtitle:
    "Evolution that reshapes the body itself — adding limbs, dropping wheels, changing plan.",
  description:
    "The Evolution Sandbox lets you tune a fixed body. This goes further: the body is data — a graph of parts and joints — that a single generic interpreter turns into a physics creature, so a two-legged crawler and a six-legged sprawler come off the same assembly line. Pick a body plan, choose what \"better\" means, and watch a population evolve a gait from random flailing. Next: letting evolution reshape the structure itself.",
  difficulty: "advanced",
  tags: [
    "genetic algorithms",
    "evolution",
    "morphology",
    "physics",
    "structural mutation",
  ],
  route: "evolving-morphology",
  mount,
  preview(root) {
    const NS = "http://www.w3.org/2000/svg";
    const groundY = 44;

    const ground = document.createElementNS(NS, "line");
    ground.setAttribute("x1", "0");
    ground.setAttribute("y1", String(groundY));
    ground.setAttribute("x2", "60");
    ground.setAttribute("y2", String(groundY));
    ground.setAttribute("class", "card-curve");
    root.append(ground);

    const bodyW = 22;
    const chassis = document.createElementNS(NS, "rect");
    chassis.setAttribute("width", String(bodyW));
    chassis.setAttribute("height", "5");
    chassis.setAttribute("rx", "1.4");
    chassis.setAttribute("class", "card-dot");
    root.append(chassis);

    // three legs, each a two-segment line, phased so they shuffle
    const legs = Array.from({ length: 3 }, () => {
      const g = document.createElementNS(NS, "polyline");
      g.setAttribute("class", "card-curve");
      g.setAttribute("fill", "none");
      root.append(g);
      return g;
    });

    const place = (cx: number, t: number) => {
      const bodyY = groundY - 12;
      chassis.setAttribute("x", (cx - bodyW / 2).toFixed(1));
      chassis.setAttribute("y", bodyY.toFixed(1));
      legs.forEach((leg, i) => {
        const hipX = cx - bodyW / 2 + 3 + i * ((bodyW - 6) / 2);
        const hipY = bodyY + 5;
        const phase = t + (i / 3) * Math.PI * 2;
        const swing = Math.sin(phase) * 3;
        const kneeX = hipX + swing;
        const kneeY = hipY + 5;
        const footX = kneeX + swing * 0.6;
        const footY = Math.min(groundY, kneeY + 5);
        leg.setAttribute(
          "points",
          `${hipX.toFixed(1)},${hipY.toFixed(1)} ${kneeX.toFixed(1)},${kneeY.toFixed(1)} ${footX.toFixed(1)},${footY.toFixed(1)}`,
        );
      });
    };

    if (reducedMotion) {
      place(30, 0);
      return;
    }
    let cx = 12;
    let t = 0;
    const tick = () => {
      cx += 0.16;
      t += 0.16;
      if (cx > 48) cx = 12;
      place(cx, t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
