// The Evolving Vehicles engine. The whole population races together in one
// physics world (cars are collision-filtered so they pass through each other);
// when the generation's time is up they're scored, bred, and the next generation
// lines up. Idle is static — nothing moves until you press Start. "Evolve ×10"
// fast-forwards headlessly (one generation per frame). All evolution logic is in
// the pure modules; this file drives them, renders, and owns the UI. Lazy-loaded
// by index.ts so planck only ships in this chunk.

import { el, svg } from "../../lib/dom.ts";
import { createTabPanel } from "../../lib/tabs.ts";
import { createInitialPopulation, GENES } from "./genome.ts";
import { createNextGeneration, pickBest } from "./evolution.ts";
import { evaluatePopulation } from "./evaluate.ts";
import { createVehicleView } from "./view.ts";
import { createPopulationSim, type PopulationSim } from "./physics.ts";
import { defaultTerrain, findTerrain, terrains } from "./terrain.ts";
import type {
  ChampionSnapshot,
  EvolutionConfig,
  EvolutionHistoryPoint,
  GeneKey,
  Terrain,
  VehicleEvaluationResult,
  VehicleGenome,
} from "./types.ts";

const MAX_HISTORY = 400;
const CHAMPION_DISTANCE = 45;

type StatusSlug = "idle" | "chaos" | "improving" | "stuck" | "champion" | "high-mutation";
type Pt = { x: number; y: number };
type InspectMode = "current" | "best";

export function mount(root: HTMLElement): () => void {
  const config: EvolutionConfig = {
    populationSize: 40,
    eliteCount: 3,
    mutationRate: 0.08,
    mutationStrength: 0.16,
    crossoverRate: 0.9,
    tournamentSize: 3,
    evaluationSeconds: 8,
  };

  let terrain: Terrain = defaultTerrain;

  const state = {
    generation: 0, // number of generations scored so far
    population: [] as VehicleGenome[], // current lineup (not yet scored)
    results: null as VehicleEvaluationResult[] | null, // scores for `population`, or null
    cached: [] as (VehicleEvaluationResult | null)[],
    champion: null as ChampionSnapshot | null, // best of the last scored generation
    bestEver: null as ChampionSnapshot | null,
    history: [] as EvolutionHistoryPoint[],
    lastImproveGen: 0,
    // run state
    sim: null as PopulationSim | null,
    evolving: false, // auto-continue after each generation
    racing: false, // sim is actively stepping
    stepOnce: false, // stop after the current race
    isReplay: false, // racing a single best-ever car, don't score/breed
    paused: false,
    pendingGens: 0, // headless fast-forward queue
    replaySpeed: 2,
    showGhost: true,
    inspectMode: "current" as InspectMode,
    statusSlug: "idle" as StatusSlug,
    statusText: "Idle",
  };

  const view = createVehicleView();
  view.setTerrain(terrain);

  let raceTrail: Pt[] = [];
  let ghostTrail: Pt[] = [];
  let raf = 0;

  const busy = () =>
    (state.racing && !state.paused) || state.pendingGens > 0 || state.isReplay;

  // ------------------------------------------------------------- generations
  function snapshot(r: VehicleEvaluationResult, generation: number): ChampionSnapshot {
    return {
      generation,
      genome: r.genome,
      fitness: r.fitness,
      maxX: r.maxX,
      averageVelocityX: r.averageVelocityX,
      terrainId: terrain.id,
    };
  }

  function scoreGeneration(results: VehicleEvaluationResult[]) {
    state.results = results;
    state.generation += 1;
    const best = pickBest(results);
    state.champion = snapshot(best, state.generation);
    const avg = results.reduce((s, r) => s + r.fitness, 0) / results.length;
    if (!state.bestEver || best.fitness > state.bestEver.fitness) {
      state.bestEver = state.champion;
      state.lastImproveGen = state.generation;
    }
    state.history.push({
      generation: state.generation,
      bestFitness: best.fitness,
      averageFitness: avg,
      bestDistance: best.maxX,
    });
    if (state.history.length > MAX_HISTORY) state.history.shift();
    deriveStatus();
    refreshInspector();
    refreshStats();
    drawGraph();
  }

  function breedNext() {
    const next = createNextGeneration({ results: state.results!, config });
    state.population = next.population;
    state.cached = next.cached;
    state.results = null;
  }

  // headless one-generation advance, used by fast-forward
  function advanceHeadless() {
    if (state.results) breedNext();
    const results = evaluatePopulation(state.population, terrain, config, state.cached);
    state.cached = [];
    scoreGeneration(results);
  }

  function buildSim() {
    state.sim?.destroy();
    state.sim = createPopulationSim(state.population, terrain);
    renderStatic();
  }

  function renderStatic() {
    if (!state.sim) return;
    view.render({
      vehicles: state.sim.renderItems(),
      focusX: state.sim.leaderX(),
      ghost: state.showGhost ? ghostTrail : undefined,
    });
  }

  function seed(full: boolean) {
    state.population = createInitialPopulation(config);
    state.results = null;
    state.cached = [];
    if (full) {
      state.generation = 0;
      state.champion = null;
      state.bestEver = null;
      state.history = [];
      state.lastImproveGen = 0;
      ghostTrail = [];
      raceTrail = [];
      state.statusSlug = "idle";
      state.statusText = "Idle — press Start";
    }
    buildSim();
    refreshInspector();
    refreshStats();
    drawGraph();
  }

  // ------------------------------------------------------------- race loop
  function renderRace() {
    if (!state.sim) return;
    const items = state.sim.renderItems();
    const leader = items.find((it) => it.isLeader) ?? items[0];
    if (leader) {
      raceTrail.push({ x: leader.state.chassis.x, y: leader.state.chassis.y });
      if (raceTrail.length > 1400) raceTrail.shift();
    }
    view.render({
      vehicles: items,
      focusX: state.sim.leaderX(),
      trail: raceTrail,
      ghost: state.showGhost ? ghostTrail : undefined,
    });
    liveDistStat.value.textContent = `${state.sim.bestMaxX().toFixed(1)} m`;
  }

  function finishRace() {
    const sim = state.sim!;
    if (state.isReplay) {
      state.isReplay = false;
      state.racing = false;
      buildSim(); // restore the current generation lineup
      syncButtons();
      return;
    }
    scoreGeneration(sim.results());
    if (state.showGhost) ghostTrail = raceTrail;
    raceTrail = [];
    const keepGoing = state.evolving && !state.stepOnce;
    breedNext();
    buildSim();
    if (keepGoing) {
      state.racing = true; // immediately race the freshly-bred generation
    } else {
      state.stepOnce = false;
      state.racing = false;
    }
    syncButtons();
  }

  function frame() {
    if (state.pendingGens > 0) {
      advanceHeadless();
      state.pendingGens -= 1;
      if (state.pendingGens === 0) {
        breedNext();
        buildSim();
        syncButtons();
      }
    } else if (state.racing && !state.paused && state.sim) {
      const steps = Math.max(1, Math.round(state.replaySpeed));
      for (let i = 0; i < steps; i++) {
        state.sim.step();
        if (state.sim.time >= config.evaluationSeconds || state.sim.allDone()) break;
      }
      renderRace();
      if (state.sim.time >= config.evaluationSeconds || state.sim.allDone()) finishRace();
    }
    raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------- actions
  function startEvolution() {
    if (busy()) return;
    state.evolving = true;
    state.stepOnce = false;
    state.racing = true;
    state.paused = false;
    syncButtons();
  }
  function pauseEvolution() {
    state.evolving = false;
    state.paused = true;
    syncButtons();
  }
  function stepGeneration() {
    if (busy()) return;
    state.evolving = false;
    state.stepOnce = true;
    state.racing = true;
    state.paused = false;
    syncButtons();
  }
  function fastForward(n: number) {
    if (busy()) return;
    state.pendingGens = n;
    state.racing = false;
    state.paused = false;
    syncButtons();
  }
  function resetAll() {
    state.evolving = false;
    state.racing = false;
    state.stepOnce = false;
    state.isReplay = false;
    state.paused = false;
    state.pendingGens = 0;
    seed(true);
    syncButtons();
  }
  function replayBestEver() {
    if (!state.bestEver || busy()) return;
    state.sim?.destroy();
    state.sim = createPopulationSim([state.bestEver.genome], terrain);
    raceTrail = [];
    state.isReplay = true;
    state.racing = true;
    state.paused = false;
    syncButtons();
  }
  function changeTerrain(id: string) {
    terrain = findTerrain(id);
    view.setTerrain(terrain);
    resetAll();
  }

  // ------------------------------------------------------------- status
  function deriveStatus() {
    const be = state.bestEver;
    if (config.mutationRate >= 0.25) {
      state.statusSlug = "high-mutation";
      state.statusText = "Too much mutation";
    } else if (be && be.maxX >= CHAMPION_DISTANCE) {
      state.statusSlug = "champion";
      state.statusText = "Champion found";
    } else if (state.generation <= 1) {
      state.statusSlug = "chaos";
      state.statusText = "Random chaos";
    } else if (state.generation - state.lastImproveGen >= 6) {
      state.statusSlug = "stuck";
      state.statusText = "Stuck";
    } else {
      state.statusSlug = "improving";
      state.statusText = "Improving";
    }
  }

  // ------------------------------------------------------------- stats DOM
  const stat = (label: string) => {
    const value = el("span", { class: "ev-stat-value" }, "—");
    const row = el(
      "div",
      { class: "ev-stat" },
      el("span", { class: "ev-stat-label" }, label),
      value,
    );
    return { row, value };
  };
  const genStat = stat("generation");
  const bestFitStat = stat("best fitness");
  const avgFitStat = stat("avg fitness");
  const bestDistStat = stat("best distance");
  const bestSpeedStat = stat("best speed");
  const liveDistStat = stat("live distance");
  const terrainStat = stat("terrain");
  const statusBadge = el("span", { class: "ev-status", "data-status": "idle" }, "Idle");

  function refreshStats() {
    genStat.value.textContent = String(state.generation);
    bestFitStat.value.textContent = state.bestEver ? state.bestEver.fitness.toFixed(1) : "—";
    const avg = state.history.length
      ? state.history[state.history.length - 1].averageFitness
      : null;
    avgFitStat.value.textContent = avg != null ? avg.toFixed(1) : "—";
    bestDistStat.value.textContent = state.bestEver ? `${state.bestEver.maxX.toFixed(1)} m` : "—";
    bestSpeedStat.value.textContent = state.bestEver
      ? `${state.bestEver.averageVelocityX.toFixed(2)} m/s`
      : "—";
    terrainStat.value.textContent = terrain.label;
    statusBadge.textContent = state.statusText;
    statusBadge.setAttribute("data-status", state.statusSlug);
    updateExplanation();
  }

  // ------------------------------------------------------------- inspector
  const inspectorRows = new Map<GeneKey, HTMLElement>();
  const currentBtn = el("button", { type: "button", class: "ev-seg ev-seg--on" }, "Current gen");
  const bestBtn = el("button", { type: "button", class: "ev-seg" }, "Best ever");
  currentBtn.addEventListener("click", () => setInspectMode("current"));
  bestBtn.addEventListener("click", () => setInspectMode("best"));
  const inspectorSourceNote = el("p", { class: "ev-note" });
  const inspector = el(
    "div",
    { class: "ev-inspector" },
    el(
      "div",
      { class: "ev-seg-group", role: "group", "aria-label": "Which genome to inspect" },
      currentBtn,
      bestBtn,
    ),
    inspectorSourceNote,
  );
  {
    const groups = new Map<string, GeneKey[]>();
    for (const g of GENES) {
      if (!groups.has(g.group)) groups.set(g.group, []);
      groups.get(g.group)!.push(g.key);
    }
    for (const [group, keys] of groups) {
      inspector.append(el("h4", { class: "ev-inspector-group" }, group));
      for (const key of keys) {
        const spec = GENES.find((g) => g.key === key)!;
        const value = el("span", { class: "ev-stat-value" }, "—");
        inspectorRows.set(key, value);
        inspector.append(
          el(
            "div",
            { class: "ev-stat" },
            el("span", { class: "ev-stat-label" }, spec.label),
            value,
          ),
        );
      }
    }
  }
  function setInspectMode(mode: InspectMode) {
    state.inspectMode = mode;
    currentBtn.classList.toggle("ev-seg--on", mode === "current");
    bestBtn.classList.toggle("ev-seg--on", mode === "best");
    refreshInspector();
  }
  function refreshInspector() {
    const g =
      state.inspectMode === "best"
        ? state.bestEver?.genome
        : state.champion?.genome;
    inspectorSourceNote.textContent =
      state.inspectMode === "best"
        ? state.bestEver
          ? `Best ever — from generation ${state.bestEver.generation}.`
          : "No champion yet — press Start."
        : state.champion
          ? `Best of generation ${state.champion.generation}. Changes as the population evolves.`
          : "No generation scored yet — press Start.";
    for (const spec of GENES) {
      const row = inspectorRows.get(spec.key);
      if (!row) continue;
      if (!g) {
        row.textContent = "—";
        continue;
      }
      const v = g[spec.key];
      row.textContent = spec.unit ? `${v.toFixed(2)} ${spec.unit}` : v.toFixed(2);
    }
  }

  // ------------------------------------------------------------- graph
  const GW = 660;
  const GH = 150;
  const GP = 24;
  const graphBest = svg("polyline", { class: "ev-graph-best" });
  const graphAvg = svg("polyline", { class: "ev-graph-avg" });
  const graphSvg = svg(
    "svg",
    {
      viewBox: `0 0 ${GW} ${GH}`,
      class: "ev-graph",
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": "Best and average fitness per generation",
    },
    svg("line", { x1: GP, y1: GH - GP, x2: GW - GP, y2: GH - GP, class: "ev-graph-axis" }),
    graphAvg,
    graphBest,
  );
  function drawGraph() {
    const h = state.history;
    if (h.length < 2) {
      graphBest.setAttribute("points", "");
      graphAvg.setAttribute("points", "");
      return;
    }
    const maxF = Math.max(...h.map((p) => p.bestFitness), 1);
    const minF = Math.min(0, ...h.map((p) => p.averageFitness));
    const gMin = h[0].generation;
    const span = Math.max(1, h[h.length - 1].generation - gMin);
    const px = (g: number) => GP + ((g - gMin) / span) * (GW - GP * 2);
    const py = (f: number) => GH - GP - ((f - minF) / (maxF - minF || 1)) * (GH - GP * 2);
    graphBest.setAttribute("points", h.map((p) => `${px(p.generation).toFixed(1)},${py(p.bestFitness).toFixed(1)}`).join(" "));
    graphAvg.setAttribute("points", h.map((p) => `${px(p.generation).toFixed(1)},${py(p.averageFitness).toFixed(1)}`).join(" "));
  }

  // ------------------------------------------------------------- controls
  function slider(opts: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format: (v: number) => string;
    onInput: (v: number) => void;
  }) {
    const valueEl = el("span", { class: "ev-slider-value" }, opts.format(opts.value));
    const input = el("input", {
      type: "range",
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: String(opts.value),
      class: "ev-slider-input",
      "aria-label": opts.label,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const v = Number(input.value);
      valueEl.textContent = opts.format(v);
      opts.onInput(v);
    });
    const field = el(
      "label",
      { class: "ev-field" },
      el("span", { class: "ev-field-head" }, el("span", {}, opts.label), valueEl),
      input,
    );
    return { field };
  }

  const btn = (label: string, onClick: () => void, primary = false) =>
    el("button", { type: "button", class: primary ? "ev-btn ev-btn--primary" : "ev-btn", onClick }, label);
  const startBtn = btn("Start evolution", startEvolution, true);
  const pauseBtn = btn("Pause", pauseEvolution);
  const stepBtn = btn("Step gen", stepGeneration);
  const ffBtn = btn("Evolve ×10", () => fastForward(10));
  const resetBtn = btn("Reset", resetAll);
  const replayBestBtn = btn("Replay best ever", replayBestEver);
  function syncButtons() {
    const b = busy();
    startBtn.toggleAttribute("disabled", b);
    pauseBtn.toggleAttribute("disabled", !state.racing || state.paused);
    stepBtn.toggleAttribute("disabled", b);
    ffBtn.toggleAttribute("disabled", b);
    replayBestBtn.toggleAttribute("disabled", !state.bestEver || b);
  }

  const terrainSelect = el(
    "select",
    { class: "ev-select", "aria-label": "Terrain" },
    ...terrains.map((t) => el("option", { value: t.id }, t.label)),
  ) as HTMLSelectElement;
  terrainSelect.value = terrain.id;
  terrainSelect.addEventListener("change", () => changeTerrain(terrainSelect.value));

  const ghostToggle = el("input", {
    type: "checkbox",
    class: "ev-check",
    "aria-label": "Show ghost of previous champion",
  }) as HTMLInputElement;
  ghostToggle.checked = state.showGhost;
  ghostToggle.addEventListener("change", () => {
    state.showGhost = ghostToggle.checked;
  });

  const controlsTab = el(
    "div",
    { class: "side-controls" },
    el(
      "div",
      { class: "ev-status-row" },
      el("span", { class: "ev-controls-title" }, "Status"),
      statusBadge,
    ),
    el("div", { class: "ev-buttons" }, startBtn, pauseBtn, stepBtn, ffBtn, resetBtn, replayBestBtn),
    field("Terrain", terrainSelect),
    slider({
      label: "Population size",
      min: 12,
      max: 120,
      step: 4,
      value: config.populationSize,
      format: (v) => String(v),
      onInput: (v) => {
        config.populationSize = v;
        resetAll();
      },
    }).field,
    slider({
      label: "Mutation rate",
      min: 0,
      max: 0.4,
      step: 0.01,
      value: config.mutationRate,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => {
        config.mutationRate = v;
        deriveStatus();
        refreshStats();
      },
    }).field,
    slider({
      label: "Mutation strength",
      min: 0.02,
      max: 0.5,
      step: 0.02,
      value: config.mutationStrength,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        config.mutationStrength = v;
      },
    }).field,
    slider({
      label: "Elite count",
      min: 0,
      max: 12,
      step: 1,
      value: config.eliteCount,
      format: (v) => String(v),
      onInput: (v) => {
        config.eliteCount = v;
      },
    }).field,
    slider({
      label: "Tournament size",
      min: 2,
      max: 8,
      step: 1,
      value: config.tournamentSize,
      format: (v) => String(v),
      onInput: (v) => {
        config.tournamentSize = v;
      },
    }).field,
    slider({
      label: "Evaluation time",
      min: 5,
      max: 18,
      step: 1,
      value: config.evaluationSeconds,
      format: (v) => `${v}s`,
      onInput: (v) => {
        config.evaluationSeconds = v;
      },
    }).field,
    slider({
      label: "Race speed",
      min: 1,
      max: 8,
      step: 1,
      value: state.replaySpeed,
      format: (v) => `${v}×`,
      onInput: (v) => {
        state.replaySpeed = v;
      },
    }).field,
    el("label", { class: "ev-toggle" }, ghostToggle, el("span", {}, "Show previous-champion ghost")),
  );

  const statsTab = el(
    "div",
    { class: "ev-stats" },
    genStat.row,
    liveDistStat.row,
    bestFitStat.row,
    avgFitStat.row,
    bestDistStat.row,
    bestSpeedStat.row,
    terrainStat.row,
  );

  // ------------------------------------------------------------- explanation
  const explanationNote = el("p", { class: "ev-tip" });
  function updateExplanation() {
    explanationNote.textContent = deriveExplanationNote();
  }
  function deriveExplanationNote(): string {
    if (config.mutationRate >= 0.25)
      return "Mutation is high: the population explores aggressively but keeps scrambling good traits before they stabilize.";
    if (config.mutationRate <= 0.01)
      return "Mutation is very low: good designs are preserved, but the population may stop discovering new shapes.";
    if (state.statusSlug === "stuck")
      return "Progress has stalled. Try raising mutation rate or strength to escape the local optimum.";
    if (state.bestEver && state.bestEver.maxX >= CHAMPION_DISTANCE)
      return "A capable vehicle has evolved. Selection is now refining a shape that already works — compare Current gen vs Best ever in the Genome tab.";
    return "Random designs are being filtered: the ones that happen to roll a little farther become parents, and their useful traits spread.";
  }

  const explanation = el(
    "section",
    { class: "ev-explanation" },
    el("h3", {}, "What's happening?"),
    el(
      "p",
      {},
      "Every car you see is built from a ",
      el("strong", {}, "genome"),
      " — numbers describing its chassis, wheels, motors, and suspension. The whole population races the ",
      el("strong", {}, "same terrain"),
      " at once (they pass through each other), scored on distance, stability, and efficiency.",
    ),
    el(
      "p",
      {},
      "The best genomes become parents. Traits are mixed with ",
      el("strong", {}, "crossover"),
      " and nudged with ",
      el("strong", {}, "mutation"),
      "; ",
      el("strong", {}, "elitism"),
      " carries the top designs through untouched. Evolution isn't intelligent — it's a filter that keeps slightly better mistakes.",
    ),
    explanationNote,
  );

  // ------------------------------------------------------------- layout
  const graphWrap = el(
    "div",
    { class: "ev-graph-wrap" },
    el(
      "div",
      { class: "ev-graph-head" },
      el("span", {}, "Fitness over generations"),
      el(
        "span",
        { class: "ev-graph-legend" },
        el("span", { class: "ev-legend ev-legend--best" }, "best"),
        el("span", { class: "ev-legend ev-legend--avg" }, "average"),
      ),
    ),
    graphSvg,
  );

  const stage = el(
    "div",
    { class: "concept-stage" },
    el("div", { class: "concept-stage-main" }, view.el),
    el("div", { class: "concept-stage-foot" }, graphWrap),
  );

  const panel = createTabPanel(
    [
      { id: "controls", label: "Controls", content: controlsTab },
      { id: "genome", label: "Genome", content: inspector },
      { id: "stats", label: "Stats", content: statsTab },
      { id: "notes", label: "Notes", content: explanation },
    ],
    { ariaLabel: "Evolving Vehicles panel" },
  );

  const aside = el(
    "aside",
    { class: "concept-aside" },
    el(
      "div",
      { class: "concept-aside-head" },
      el("a", { href: "#/", class: "concept-back" }, "← All concepts"),
      el("h1", { class: "concept-title" }, "Evolving Vehicles"),
      el(
        "p",
        { class: "concept-sub" },
        "Natural selection, but with cursed engineering. A whole population of random machines evolves to cross rough terrain.",
      ),
    ),
    panel.el,
  );

  const page = el("div", { class: "concept-shell" }, stage, aside);

  document.body.classList.add("concept-open");
  root.replaceChildren(page);
  seed(true);
  syncButtons();
  raf = requestAnimationFrame(frame);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    state.sim?.destroy();
    view.dispose();
    document.body.classList.remove("concept-open");
  };
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el(
    "label",
    { class: "ev-field" },
    el("span", { class: "ev-field-head" }, el("span", {}, label)),
    control,
  );
}
