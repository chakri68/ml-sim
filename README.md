# ML Visualizations Lab

Machine learning, but you can see it move.

It's a small museum for ML concepts you can drag, break, reset, and (ideally)
understand. Right now the museum has exactly one exhibit, which is a very
"just exploring the possibilites ✨" number of exhibits — but the whole thing is
built so that adding the next one is a data change, not a weekend of regret.

Live: **[ml-sims.chakri.me](https://ml-sims.chakri.me/)**

## The exhibit: Gradient Descent

Watch an optimizer look at the slope, step the other way, and repeat until it
stops (or doesn't). The real point is the learning-rate slider: drag it and
_feel_ the difference between crawl, converge, overshoot, and full-blown diverge,
instead of nodding along at an inequality in a textbook.

- **1D curve** (hand-rolled SVG) and a **3D loss surface** (Three.js, orbit
  controls, warm-phosphor heightmap so you can actually read the elevation).
- **Five optimizers** — Gradient Descent, SGD (the noisy one), Momentum, RMSProp,
  Adam. Point them at the ill-conditioned "banana valley" and watch plain GD
  zig-zag across the walls while the adaptive ones cut down the trough.
- **Bring your own function** — type `f(x)` or `f(x,y)`, parsed with mathjs and
  differentiated symbolically (numeric fallback for when the symbolic path gives up).

## Stack

Vanilla **TypeScript + Vite**. No UI framework — the DOM was right there and I
wanted it. 1D is imperative **SVG**, 3D is **Three.js**, custom expressions run
through **mathjs**. Amber-on-black CRT-terminal aesthetic, because of course.

The one design call that actually paid off: the optimizer step logic is
**dimension-agnostic** — it operates on a parameter vector, so the exact same
code drives the 1D curve and the 2D surface. Write the math once, render it two
ways.

```
src/lib/                       DOM builders (el/svg), math + coordinate helpers, fade transitions
src/router.ts                  tiny hash router, per-route cleanup, keeps <title>/meta in sync
src/pages/  src/components/     homepage grid, boot loader
src/concepts/registry.ts       the list the homepage maps over — add a concept here
src/concepts/gradient-descent/
  functions.ts                 unified 1D/2D loss functions + custom-expression compiler
  optimizers.ts                GD / SGD / Momentum / RMSProp / Adam, all dimension-agnostic
  view.ts                      shared View interface + engine state
  view2d.ts / view3d.ts        SVG curve / Three.js surface
  engine.ts                    state machine, controls, animation loop (lazy-loaded)
  index.ts                     metadata + card preview + the lazy loader
```

Three.js and mathjs are the heavy tenants, so they live in `engine.ts`, which is
dynamically imported. The homepage bundle stays ~3 kB gzipped and the expensive
stuff only loads when you actually open a concept.

## Run it

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # typecheck + production bundle to dist/
npm run preview   # serve the built version
```

## Things I decided on purpose

- **Discrete steps, not per-frame animation.** GD converges in ~30–50 steps, so
  the loop steps on a timer (the speed slider is steps/sec) and the SVG point
  _tweens_ between steps in CSS. Smoother, and no re-render thrash.
- **Divergence won't crash the party.** `NaN`/overflow is guarded, and a point
  that flies off-chart pins to the plot edge instead of quietly vanishing.
- **Behaves for everyone.** Respects `prefers-reduced-motion`, controls are
  keyboard-accessible, and status is spelled out in text — not color alone.

## Adding a concept

The homepage is just `registry.ts` mapped over. A new exhibit is a metadata entry
plus a folder that exports a `mount()` returning its cleanup — no central refactor,
no ceremony. That's the whole pitch: a museum designed to grow one curiosity at a
time.

See [`design.md`](./design.md) if you want the full product-design writeup.

---

Busy building Rome. This is one of the bricks.
