import { el } from "../lib/dom.ts";

const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

// Small first-impression loader. Waits only for fonts + a short minimum, then
// fades out. It never blocks on visualization assets — those lazy-load per page.
export function runLoader(host: HTMLElement): Promise<void> {
  const glyphs = ["∂", "∇", "Σ", "α", "λ"].map((g, i) =>
    el(
      "span",
      { class: "loader-glyph", style: { animationDelay: `${i * 0.12}s` } },
      g,
    ),
  );

  const overlay = el(
    "div",
    { class: "loader" },
    el(
      "div",
      { class: "loader-inner" },
      el("div", { class: "loader-glyphs" }, ...glyphs),
      el("p", { class: "loader-title" }, "ML Visualizations Lab"),
      el("p", { class: "loader-text" }, "Preparing the playground…"),
    ),
  );
  host.append(overlay);

  const minDelay = reducedMotion ? 0 : 900;
  const fonts =
    (document as Document & { fonts?: FontFaceSet }).fonts?.ready ??
    Promise.resolve();

  return Promise.all([fonts, wait(minDelay)]).then(
    () =>
      new Promise<void>((resolve) => {
        if (reducedMotion) {
          overlay.remove();
          resolve();
          return;
        }
        overlay.classList.add("loader--out");
        overlay.addEventListener(
          "transitionend",
          () => {
            overlay.remove();
            resolve();
          },
          { once: true },
        );
      }),
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
