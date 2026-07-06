# ML Visualizations Lab

An interactive playground for learning machine learning concepts through visual,
animated, hands-on simulations. The goal is to make ML concepts feel less like
static equations and more like systems you can poke, break, and understand.

**First concept: Gradient Descent** — watch optimizers look at the slope, step in
the opposite direction, and repeat until they reach a minimum. Change the learning
rate and _feel_ what it does: crawl, converge, overshoot, or diverge. Includes:

- **1D curve view** (SVG) and a **3D loss-surface view** (Three.js) with orbit controls.
- **Five optimizers** — Gradient Descent, SGD (stochastic/noisy), Momentum, RMSProp,
  Adam — best compared on the ill-conditioned "ravine" surface, where plain GD
  zig-zags and the adaptive methods cut straight down the valley.
- **Custom functions** — type your own `f(x)` (curve) or `f(x,y)` (surface); parsed
  with mathjs and differentiated symbolically (numeric fallback).

## Stack

Vanilla **TypeScript + Vite** — no UI framework. 1D is imperative **SVG**; 3D is
**Three.js**; custom expressions use **mathjs**. The optimizer step logic is
dimension-agnostic (operates on a parameter vector), so the same code drives both
the 1D curve and the 2D surface.

- `src/lib/` — DOM builders (`el`/`svg`) and math/coordinate helpers
- `src/concepts/registry.ts` — the concept list the homepage maps over
- `src/concepts/gradient-descent/`
  - `functions.ts` — unified 1D/2D loss functions + custom-expression compiler (mathjs)
  - `optimizers.ts` — GD/SGD/Momentum/RMSProp/Adam, dimension-agnostic
  - `view.ts` — shared `View` interface + engine state
  - `view2d.ts` (SVG curve) / `view3d.ts` (Three.js surface)
  - `engine.ts` — state machine, controls, animation loop (lazy-loaded chunk)
  - `index.ts` — concept metadata + card preview + the lazy loader
- `src/pages/`, `src/components/` — homepage, loader
- `src/router.ts` — tiny hash router with per-route cleanup

Adding a concept is a data change in `registry.ts`, not a refactor. Three.js and
mathjs live in `engine.ts`, which is dynamically imported so the homepage bundle
stays ~3 kB gzipped and the heavy engine loads only when the concept page opens.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production bundle to dist/
npm run preview  # serve the production build
```

## Design notes

- **Discrete stepping, not per-frame animation.** Gradient descent converges in
  ~30–50 steps, so the loop steps on a timer (speed slider = steps/sec) and the
  SVG point _tweens_ between steps via CSS. No re-render thrash, smoother motion.
- **Divergence is guarded** against `NaN`/overflow, and an off-chart point pins to
  the plot edge instead of vanishing.
- Respects `prefers-reduced-motion`; controls are keyboard-accessible; status is
  conveyed by text, not color alone.

See [`design.md`](./design.md) for the full product design.
