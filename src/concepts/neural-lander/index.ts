// Lightweight concept entry: metadata + a cheap animated card preview, with the
// heavy engine (planck physics, workers) lazy-loaded only when the page opens.

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
      el("p", {}, "Fuelling landers…"),
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

export const neuralLander: Concept = {
  id: "neural-lander",
  title: "Neural Lander",
  subtitle: "Evolve a neural network that lands a rover on a pad.",
  description:
    "A rover with real sensors and thrusters, flown by a tiny neural network. A population of random brains is dropped over a planet; the ones that crash least gently become parents. Watch neuroevolution turn chaos into controlled descents, then test the champion on terrain it has never seen.",
  difficulty: "advanced",
  tags: [
    "neural networks",
    "neuroevolution",
    "control",
    "physics",
    "generalization",
  ],
  route: "neural-lander",
  mount,
  preview(root) {
    // A little lander easing down onto a pad, flame shrinking as it slows.
    const NS = "http://www.w3.org/2000/svg";
    const groundY = 48;
    const ground = document.createElementNS(NS, "polyline");
    ground.setAttribute(
      "points",
      "0,44 8,41 14,45 20,48 40,48 46,43 52,46 60,42",
    );
    ground.setAttribute("class", "card-curve");
    root.append(ground);

    const hull = document.createElementNS(NS, "polygon");
    hull.setAttribute("class", "card-dot");
    const legs = document.createElementNS(NS, "polyline");
    legs.setAttribute("class", "card-curve");
    legs.setAttribute("fill", "none");
    const flame = document.createElementNS(NS, "polygon");
    flame.setAttribute("class", "card-dot");
    flame.setAttribute("opacity", "0.55");
    root.append(flame, legs, hull);

    const place = (cy: number, burn: number) => {
      const cx = 30;
      hull.setAttribute(
        "points",
        `${cx - 5},${cy + 3} ${cx + 5},${cy + 3} ${cx + 3.5},${cy - 3} ${cx - 3.5},${cy - 3}`,
      );
      legs.setAttribute(
        "points",
        `${cx - 7.5},${cy + 8} ${cx - 3.5},${cy + 3} ${cx + 3.5},${cy + 3} ${cx + 7.5},${cy + 8}`,
      );
      const len = 2 + burn * 9;
      flame.setAttribute(
        "points",
        `${cx - 1.6},${cy + 3} ${cx},${cy + 3 + len} ${cx + 1.6},${cy + 3}`,
      );
    };

    const restY = groundY - 8;
    if (reducedMotion) {
      place(restY, 0);
      return;
    }
    let t = 0;
    const tick = () => {
      t += 1 / 60;
      const T = 4.2;
      const p = (t % T) / T;
      // ease-out descent, a short rest, then back to the top
      const d = Math.min(1, p / 0.8);
      const y = 6 + (restY - 6) * (1 - (1 - d) * (1 - d));
      place(y, d < 1 ? 1 - d * 0.8 : 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
