// Lightweight concept entry: metadata + a cheap animated card preview (a little
// wheeled machine rolling along), with the heavy engine (planck physics)
// lazy-loaded only when the page opens — so the homepage bundle never pulls in
// the physics library.

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

export const evolutionSandbox: Concept = {
  id: "evolution-sandbox",
  title: "Evolution Sandbox",
  subtitle:
    "Build a body, define success, and watch evolution exploit your rules.",
  description:
    'A tiny evolution laboratory. Choose a body template (a wheeled rover or a limbed crawler), edit each gene\'s range to design the search space, then write a safe fitness formula that says what "better" means. A whole population is dropped into a 2D physics world, scored by your formula, and bred over generations — and the lesson lands fast: evolution optimizes exactly what you reward, not what you meant.',
  difficulty: "advanced",
  tags: [
    "genetic algorithms",
    "evolution",
    "sandbox",
    "physics",
    "optimization",
    "DSL",
  ],
  route: "evolution-sandbox",
  mount,
  preview(root) {
    const NS = "http://www.w3.org/2000/svg";
    const groundY = 40;

    const ground = document.createElementNS(NS, "line");
    ground.setAttribute("x1", "0");
    ground.setAttribute("y1", String(groundY));
    ground.setAttribute("x2", "60");
    ground.setAttribute("y2", String(groundY));
    ground.setAttribute("class", "card-curve");
    root.append(ground);

    const chassis = document.createElementNS(NS, "rect");
    chassis.setAttribute("width", "16");
    chassis.setAttribute("height", "5");
    chassis.setAttribute("rx", "1.4");
    chassis.setAttribute("class", "card-dot");
    root.append(chassis);

    const wheels = [
      document.createElementNS(NS, "circle"),
      document.createElementNS(NS, "circle"),
    ];
    for (const w of wheels) {
      w.setAttribute("r", "3.4");
      w.setAttribute("class", "card-curve");
      w.setAttribute("fill", "none");
      root.append(w);
    }

    const place = (cx: number, spin: number) => {
      const bodyY = groundY - 9;
      chassis.setAttribute("x", (cx - 8).toFixed(1));
      chassis.setAttribute("y", bodyY.toFixed(1));
      wheels.forEach((w, i) => {
        const wx = cx + (i === 0 ? -5 : 5);
        const wy = groundY - 3.4;
        w.setAttribute("cx", wx.toFixed(1));
        w.setAttribute("cy", wy.toFixed(1));
        w.setAttribute(
          "transform",
          `rotate(${(spin * (i === 0 ? 1 : 1)).toFixed(1)} ${wx.toFixed(1)} ${wy.toFixed(1)})`,
        );
      });
    };

    if (reducedMotion) {
      place(30, 0);
      return;
    }
    let cx = 10;
    let spin = 0;
    const tick = () => {
      cx += 0.18;
      spin += 6;
      if (cx > 50) cx = 10;
      place(cx, spin);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
