// Lightweight concept entry: metadata + a cheap animated card preview, with the
// heavier engine lazy-loaded only when the page opens (mirrors gradient-descent
// so the homepage bundle stays small).

import { el, svg } from "../../lib/dom.ts";
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
      el("div", { class: "gd-loading-dots" }, "∵ ∴ ∵"),
      el("p", {}, "Loading visualization…"),
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

export const geneticAlgorithms: Concept = {
  id: "genetic-algorithms",
  title: "Genetic Algorithms",
  subtitle: "Evolve random guesses into maze-solving behavior.",
  description:
    "Watch a population of tiny agents evolve from random movement into maze-solving behavior — selection, crossover, mutation, and elitism, one generation at a time.",
  difficulty: "beginner",
  tags: ["evolution", "optimization", "mutation", "search"],
  route: "genetic-algorithms",
  mount,
  preview(root) {
    // A few dots drift toward a glowing target, then respawn — a tiny loop that
    // hints at "random attempts converging" without simulating anything real.
    const NS = "http://www.w3.org/2000/svg";
    const TARGET = { x: 50, y: 10 };
    const START = { x: 10, y: 38 };

    const targetDot = svg("circle", {
      cx: TARGET.x,
      cy: TARGET.y,
      r: 3.5,
      class: "card-dot",
    });
    root.append(targetDot);

    const N = 4;
    const dots: SVGCircleElement[] = [];
    for (let i = 0; i < N; i++) {
      const d = document.createElementNS(NS, "circle");
      d.setAttribute("r", "1.8");
      d.setAttribute("class", "card-curve");
      d.setAttribute("fill", "var(--accent-dim)");
      d.setAttribute("stroke", "none");
      root.append(d);
      dots.push(d);
    }

    const place = (t: number) => {
      for (let i = 0; i < N; i++) {
        // each dot takes a slightly different, wavy route toward the target
        const jitter = Math.sin(t * 6 + i * 1.7) * (1 - t) * 9;
        const x = START.x + (TARGET.x - START.x) * t + jitter;
        const y = START.y + (TARGET.y - START.y) * t - jitter * 0.6;
        dots[i].setAttribute("cx", x.toFixed(1));
        dots[i].setAttribute("cy", y.toFixed(1));
        dots[i].setAttribute("opacity", (0.35 + t * 0.55).toFixed(2));
      }
    };

    if (reducedMotion) {
      place(0.6);
      return;
    }
    let p = 0;
    const tick = () => {
      p = (p + 0.006) % 1.3;
      place(Math.min(p, 1));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
