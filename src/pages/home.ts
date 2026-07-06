import { el, svg } from "../lib/dom.ts";
import { concepts } from "../concepts/registry.ts";
import type { Concept } from "../concepts/types.ts";

function card(concept: Concept): HTMLElement {
  const art = svg("svg", { viewBox: "0 0 60 48", class: "card-art" });
  concept.preview?.(art);

  return el(
    "a",
    { href: `#/concepts/${concept.route}`, class: "card" },
    el("div", { class: "card-art-wrap" }, art),
    el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "card-top" },
        el("h2", {}, concept.title),
        el(
          "span",
          { class: `badge badge--${concept.difficulty}` },
          concept.difficulty,
        ),
      ),
      el("p", { class: "card-sub" }, concept.subtitle),
      el(
        "div",
        { class: "card-tags" },
        ...concept.tags.map((t) => el("span", { class: "tag" }, t)),
      ),
      el("span", { class: "card-explore" }, "Explore →"),
    ),
  );
}

export function renderHome(root: HTMLElement): () => void {
  const grid = el("div", { class: "grid" }, ...concepts.map(card));

  const page = el(
    "div",
    { class: "home" },
    el(
      "header",
      { class: "hero" },
      el("p", { class: "hero-kicker" }, "ML Visualizations Lab"),
      el("h1", {}, "Machine Learning, but you can see it move."),
      el(
        "p",
        { class: "hero-sub" },
        "A collection of interactive visualizations that turn ML concepts into experiments you can drag, break, reset, and understand.",
      ),
    ),
    el(
      "section",
      { class: "grid-section" },
      el("h2", { class: "grid-title" }, "Concepts"),
      grid,
    ),
    el(
      "footer",
      { class: "site-footer" },
      el("span", {}, "Built with Vite + TypeScript + SVG."),
      el(
        "a",
        { href: "https://github.com", target: "_blank", rel: "noreferrer" },
        "GitHub",
      ),
    ),
  );

  root.replaceChildren(page);
  return () => {};
}
