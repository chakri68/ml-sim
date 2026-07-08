# ML Visualizations Lab

Machine learning, but you can see it move.

It's a small museum for ML concepts you can drag, break, reset, and (ideally)
understand. It started with a single exhibit and grew into a handful — because
the whole thing is built so that adding the next one is a data change, not a
weekend of regret.

Live: **[ml-sims.chakri.me](https://ml-sims.chakri.me/)**

## The exhibits

### Gradient Descent

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

### Genetic Algorithms

Evolve random guesses into maze-solving behaviour. A population starts with
garbage movement instructions; selection, crossover, and mutation turn flailing
into a route. The first proof that "no gradient, just survival of the fittest"
is enough to get somewhere.

### Evolving Vehicles

Natural selection, but with cursed engineering. A whole population of random
machines — chassis, wheels, motors, suspension — is dropped onto rough terrain
and scored on how far it gets. Over generations, the junkyard learns to drive.

### Evolving Creatures

A genome encodes both a creature's **body** and the rhythmic sine-wave motors
driving its joints. Nobody teaches it to walk; it's born with a shape and a
rhythm. Selection evolves morphology and gait _together_, until accidental
flailing becomes something that genuinely crawls.

### Evolution Sandbox

The capstone: instead of watching a fixed experiment, you run one. Pick a body
template (a wheeled **rover** or a limbed **crawler**), edit each gene's range to
design the **search space**, then write a **fitness formula** in a small safe
expression language that says what "better" means. A whole population is scored
by your formula and bred over generations — and the lesson lands fast:

> Evolution optimizes exactly what you reward, not what you meant.

Reward distance only and watch something spin or drag its way forward; the
per-term **fitness breakdown** shows you _why_ the champion won. Presets get you
started, metric chips grey out anything a given body can't actually move, and you
can export/import an experiment as JSON to share a cursed creation.

## Stack

Vanilla **TypeScript + Vite**. No UI framework — the DOM was right there and I
wanted it. Curves and creatures are imperative **SVG**, the 3D surface is
**Three.js**, custom expressions run through **mathjs**, and the physics exhibits
run on **planck** (a Box2D port) in a fixed-timestep world.

A couple of design calls that actually paid off:

- **The optimizer step logic is dimension-agnostic** — it operates on a parameter
  vector, so the same code drives the 1D curve and the 2D surface.
- **The physics exhibits share their spine.** A generation of individuals races
  in _one_ world (collision-filtered so they pass through each other), headless
  fast-forward runs in a **Web Worker** so the main thread never stutters, and the
  genome is a flat bag of named genes driven by a schema table — so random /
  crossover / mutation / inspector are all tiny data-driven loops. Evolution
  Sandbox takes this one step further: its engine is _template-agnostic_, so a
  rover and a crawler run through the exact same code.
- **Terrain is procedural and seeded** (`src/lib/terrain.ts`). Rather than a
  stored array of points, terrain is a compact descriptor plus a pure,
  seed-derived `height(x)` — so the ground is deterministic (fitness stays
  comparable, replays reproduce), scrolls infinitely (the view samples only the
  visible window), and is safe to hand a Web Worker (it's all primitives).

```
src/lib/                       DOM builders (el/svg), math helpers, procedural terrain, transitions
src/router.ts                  tiny hash router, per-route cleanup, keeps <title>/meta in sync
src/pages/  src/components/    homepage grid, boot loader
src/concepts/registry.ts       the list the homepage maps over — add a concept here
src/concepts/gradient-descent/ 1D/2D loss functions, 5 optimizers, SVG + Three.js views
src/concepts/genetic-algorithms/  maze-solving GA
src/concepts/evolving-vehicles/   planck cars over terrain
src/concepts/evolving-creatures/  planck two-limbed crawler, evolved gait
src/concepts/evolution-sandbox/   templates + gene-range editor + fitness DSL + breakdown
```

Three.js, mathjs, and planck are the heavy tenants, so each concept's `engine.ts`
is dynamically imported. The homepage bundle stays tiny and the expensive stuff
only loads when you actually open a concept.

## Run it

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # typecheck + production bundle to dist/
npm run preview   # serve the built version
```

## Things I decided on purpose

- **Discrete steps, not per-frame animation** (Gradient Descent). GD converges in
  ~30–50 steps, so the loop steps on a timer and the SVG point _tweens_ between
  steps in CSS. Smoother, and no re-render thrash.
- **Divergence won't crash the party.** `NaN`/overflow is guarded everywhere — an
  optimizer point that flies off-chart pins to the edge, and a physics body that
  explodes is scored gracefully rather than taking the tab down.
- **The fitness language is a language, not `eval`.** The sandbox parses your
  formula into a tiny AST over an allow-list of metrics and math — no property
  access, no globals, no code execution. The dangerous forms simply have no grammar.
- **Behaves for everyone.** Respects `prefers-reduced-motion`, controls are
  keyboard-accessible, and status is spelled out in text — not color alone.

## Adding a concept

The homepage is just `registry.ts` mapped over. A new exhibit is a metadata entry
plus a folder that exports a `mount()` returning its cleanup — no central refactor,
no ceremony. That's the whole pitch: a museum designed to grow one curiosity at a
time.

---
