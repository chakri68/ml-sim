// Lightweight concept entry: metadata + a cheap animated card preview, with the
// heavy engine (planck physics) lazy-loaded only when the page opens — so the
// homepage bundle never pulls in the physics library.

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

export const evolvingVehicles: Concept = {
  id: "evolving-vehicles",
  title: "Evolving Vehicles",
  subtitle: "Watch strange machines evolve to cross rough terrain.",
  description:
    "An advanced genetic algorithm where genomes encode 2D vehicle bodies. A population of cars is dropped onto terrain and scored on how far they travel; selection, crossover, and mutation evolve better designs over generations, in a real physics simulation.",
  difficulty: "advanced",
  tags: ["evolution", "physics", "optimization", "simulation", "genetic algorithms"],
  route: "evolving-vehicles",
  mount,
  preview(root) {
    // A little cart bobbing over hills — hints at "vehicle crossing terrain"
    // without running physics.
    const NS = "http://www.w3.org/2000/svg";
    const hill = (x: number) => 30 + Math.sin(x * 0.16) * 5 + Math.sin(x * 0.4) * 2;
    const pts: string[] = [];
    for (let x = 0; x <= 60; x += 2) pts.push(`${x},${hill(x).toFixed(1)}`);
    const ground = document.createElementNS(NS, "polyline");
    ground.setAttribute("points", pts.join(" "));
    ground.setAttribute("class", "card-curve");
    root.append(ground);

    const body = document.createElementNS(NS, "rect");
    body.setAttribute("width", "10");
    body.setAttribute("height", "4");
    body.setAttribute("rx", "1");
    body.setAttribute("class", "card-dot");
    const w1 = document.createElementNS(NS, "circle");
    const w2 = document.createElementNS(NS, "circle");
    for (const w of [w1, w2]) {
      w.setAttribute("r", "2");
      w.setAttribute("class", "card-dot");
      root.append(w);
    }
    root.append(body);

    const place = (x: number) => {
      const y = hill(x);
      const slope = (hill(x + 2) - hill(x - 2)) / 4;
      const ang = Math.atan(slope);
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      body.setAttribute(
        "transform",
        `translate(${(x - 5 * cos + 4 * sin).toFixed(1)} ${(y - 5 - 5 * sin - 4 * cos).toFixed(1)}) rotate(${((ang * 180) / Math.PI).toFixed(1)})`,
      );
      w1.setAttribute("cx", (x - 3.5 * cos).toFixed(1));
      w1.setAttribute("cy", (y - 2 - 3.5 * sin).toFixed(1));
      w2.setAttribute("cx", (x + 3.5 * cos).toFixed(1));
      w2.setAttribute("cy", (y - 2 + 3.5 * sin).toFixed(1));
    };

    if (reducedMotion) {
      place(20);
      return;
    }
    let x = 6;
    const tick = () => {
      x += 0.18;
      if (x > 54) x = 6;
      place(x);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
