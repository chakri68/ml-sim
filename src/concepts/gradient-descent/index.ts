// Lightweight concept entry. Holds metadata + the card preview (both cheap) and
// lazy-loads the heavy engine (Three.js + mathjs) only when the page is opened,
// so the homepage bundle stays small.

import { el } from "../../lib/dom.ts";
import type { Concept } from "../types.ts";

const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

// Mount returns a cleanup synchronously (the router needs that), but the engine
// arrives async — so we show a loader, then hand off, and make cleanup cover both.
function mount(root: HTMLElement): () => void {
  let realCleanup: (() => void) | null = null;
  let cancelled = false;

  root.replaceChildren(
    el(
      "div",
      { class: "gd-loading" },
      el("div", { class: "gd-loading-dots" }, "∇ ∂ Σ"),
      el("p", {}, "Loading visualization…"),
    ),
  );

  import("./engine.ts").then(({ mount: engineMount }) => {
    if (cancelled) return;
    realCleanup = engineMount(root);
  });

  return () => {
    cancelled = true;
    realCleanup?.();
  };
}

export const gradientDescent: Concept = {
  id: "gradient-descent",
  title: "Gradient Descent",
  subtitle: "Watch optimizers move downhill — in 1D and on a 3D loss surface.",
  description:
    "Visualize how gradient descent and its variants (SGD, Momentum, RMSProp, Adam) update parameters to minimize a loss function. Custom functions and a 3D surface view included.",
  difficulty: "beginner",
  tags: ["optimization", "loss", "learning rate", "3D", "optimizers"],
  route: "gradient-descent",
  mount,
  preview(root) {
    const NS = "http://www.w3.org/2000/svg";
    const P0 = { x: 6, y: 8 },
      P1 = { x: 30, y: 60 },
      P2 = { x: 54, y: 8 };
    const at = (t: number) => {
      const u = 1 - t;
      return {
        x: u * u * P0.x + 2 * u * t * P1.x + t * t * P2.x,
        y: u * u * P0.y + 2 * u * t * P1.y + t * t * P2.y,
      };
    };
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${P0.x},${P0.y} Q${P1.x},${P1.y} ${P2.x},${P2.y}`);
    path.setAttribute("class", "card-curve");
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", "3.5");
    dot.setAttribute("class", "card-dot");
    root.append(path, dot);
    const place = (t: number) => {
      const pt = at(t);
      dot.setAttribute("cx", pt.x.toFixed(1));
      dot.setAttribute("cy", pt.y.toFixed(1));
    };
    if (reducedMotion) {
      place(0.5);
      return;
    }
    let p = 0;
    const tick = () => {
      p = (p + 0.007) % 1.25;
      const e = Math.min(p, 1);
      place(0.5 * (1 - (1 - e) ** 2));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
