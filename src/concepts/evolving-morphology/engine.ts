// The Evolving Morphology engine (M2 — evolution over a graph-built body). The
// whole population crawls together in one physics world (parts are collision-
// filtered so bodies pass through each other); when the generation's time is up
// they're scored by the chosen fitness preset, bred, and the next generation lines
// up. Idle is static — nothing moves until Start.
//
// What's different from Evolving Creatures: every body is assembled by the generic
// BodyGraph interpreter from a flat genome, and a "Body plan" control changes the
// leg count — the first taste of structure as something you choose, on the road to
// M3 where evolution changes it on its own. No wheels; this is limbed creatures.

import { el, svg } from "../../lib/dom.ts";
import { createTabPanel } from "../../lib/tabs.ts";
import { buildPhenotype } from "./interpreter.ts";
import { MORPH_GROUP, createPopulationSim } from "./physics.ts";
import type { PopulationSim, PhenotypeBuilder } from "./physics.ts";
import { createMorphView } from "./view.ts";
import {
  DEFAULT_LEG_COUNT,
  LEG_COUNTS,
  buildCrawlerGraph,
  planGenes,
  planGroups,
} from "./plan.ts";
import { createInitialPopulation } from "./genome.ts";
import { createNextGeneration, pickBest } from "./evolution.ts";
import { DEFAULT_PRESET_ID, FITNESS_PRESETS, findPreset } from "./fitness.ts";
import {
  breakdownFitness,
  scoreFitness,
  validateFitness,
  type CompiledFitness,
} from "./fitnessDsl.ts";
import { METRIC_CATALOG } from "./metrics.ts";
import { defaultTerrain, findTerrain, terrains } from "./terrain.ts";
import type { EvalRequest, EvalResponse } from "./eval.worker.ts";
import type {
  ChampionSnapshot,
  EvaluationResult,
  EvolutionConfig,
  FitnessBreakdownItem,
  FitnessMetrics,
  GeneSpec,
  Genome,
  HistoryPoint,
  Terrain,
} from "./types.ts";

// Metrics a limbed body can actually move — used to grey out the chips it can't
// (there are no wheels here, so wheel contact is always zero).
const MEANINGLESS_METRICS = new Set(["wheelGroundContactTime"]);

const MAX_HISTORY = 400;
const WALKER_DISTANCE = 10; // best reach that counts as "it walks"

type StatusSlug =
  | "idle"
  | "chaos"
  | "improving"
  | "stuck"
  | "walker"
  | "high-mutation"
  | "spinning"
  | "dragging";
type Pt = { x: number; y: number };
type InspectMode = "current" | "best";

export function mount(root: HTMLElement): () => void {
  const config: EvolutionConfig = {
    populationSize: 30,
    eliteCount: 3,
    mutationRate: 0.06,
    mutationStrength: 0.12,
    crossoverRate: 0.9,
    tournamentSize: 3,
    evaluationSeconds: 10,
    structuralRate: 0.05, // §23: ~5% of offspring get a structural change
  };

  let terrain: Terrain = defaultTerrain;
  let startLegs = DEFAULT_LEG_COUNT; // seed leg count; genomes then diverge

  // Fitness is now a user-editable DSL expression, not a fixed preset. `compiled`
  // is the parsed AST we score against; it's null only if the current text is
  // invalid (in which case scoring falls back to 0 and the editor shows the error).
  let fitnessSource = findPreset(DEFAULT_PRESET_ID).expression;
  const initialValidation = validateFitness(fitnessSource);
  let compiled: CompiledFitness | null = initialValidation.ok
    ? initialValidation.compiled
    : null;

  const state = {
    generation: 0,
    population: [] as Genome[],
    results: null as EvaluationResult[] | null,
    champion: null as ChampionSnapshot | null,
    bestEver: null as ChampionSnapshot | null,
    champions: [] as ChampionSnapshot[],
    lastBest: null as EvaluationResult | null,
    history: [] as HistoryPoint[],
    lastImproveGen: 0,
    sim: null as PopulationSim | null,
    evolving: false,
    racing: false,
    stepOnce: false,
    isReplay: false,
    fastForwarding: false,
    paused: false,
    replaySpeed: 2,
    showGhost: true,
    showJoints: false,
    showCoM: false,
    inspectMode: "current" as InspectMode,
    replayGen: 1,
    statusSlug: "idle" as StatusSlug,
    statusText: "Idle",
  };

  const view = createMorphView();
  view.setTerrain(terrain);

  let raceTrail: Pt[] = [];
  let ghostTrail: Pt[] = [];
  let raf = 0;

  const busy = () =>
    (state.racing && !state.paused) || state.isReplay || state.fastForwarding;

  function formatGene(spec: GeneSpec, v: number): string {
    if (spec.display === "pi") return `${(v / Math.PI).toFixed(2)}π`;
    return spec.unit ? `${v.toFixed(2)} ${spec.unit}` : v.toFixed(2);
  }

  // Score raw metrics with the current compiled expression (0 while invalid).
  function scoreMetrics(m: FitnessMetrics): number {
    return compiled ? scoreFitness(compiled.ast, m) : 0;
  }

  // --------------------------------------------------------------- worker
  // Headless fast-forward runs in a worker so the main thread never locks.
  // `ffToken` invalidates an in-flight run when the user resets / changes terrain.
  const evalWorker = new Worker(new URL("./eval.worker.ts", import.meta.url), {
    type: "module",
  });
  const evalPending = new Map<number, (m: FitnessMetrics[]) => void>();
  let evalSeq = 0;
  let ffToken = 0;
  evalWorker.onmessage = (e: MessageEvent<EvalResponse>) => {
    const resolve = evalPending.get(e.data.id);
    if (!resolve) return;
    evalPending.delete(e.data.id);
    resolve(e.data.ok ? e.data.metrics : []);
  };
  function evaluateInWorker(genomes: Genome[]): Promise<FitnessMetrics[]> {
    if (genomes.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = ++evalSeq;
      evalPending.set(id, resolve);
      const req: EvalRequest = {
        id,
        terrainId: terrain.id,
        genomes,
        evaluationSeconds: config.evaluationSeconds,
      };
      evalWorker.postMessage(req);
    });
  }

  // A phenotype builder for one genome (which carries its own structure).
  function builderFor(genome: Genome): PhenotypeBuilder {
    return (world) =>
      buildPhenotype(buildCrawlerGraph(genome), world, terrain, MORPH_GROUP);
  }

  // Score the finished race: zip each genome with the metrics it earned.
  function collectResults(): EvaluationResult[] {
    const ms = state.sim!.metricsList();
    return state.population.map((genome, i) => ({
      genome,
      metrics: ms[i],
      fitness: scoreMetrics(ms[i]),
    }));
  }

  // ------------------------------------------------------------- generations
  function snapshot(r: EvaluationResult, generation: number): ChampionSnapshot {
    return {
      generation,
      genome: r.genome,
      fitness: r.fitness,
      metrics: r.metrics,
      terrainId: terrain.id,
    };
  }

  function scoreGeneration(results: EvaluationResult[]) {
    state.results = results;
    state.generation += 1;
    const best = pickBest(results);
    state.lastBest = best;
    state.champion = snapshot(best, state.generation);
    state.champions.push(state.champion);
    const avg = results.reduce((s, r) => s + r.fitness, 0) / results.length;
    const avgDist =
      results.reduce((s, r) => s + r.metrics.distance, 0) / results.length;
    if (!state.bestEver || best.fitness > state.bestEver.fitness) {
      state.bestEver = state.champion;
      state.lastImproveGen = state.generation;
    }
    state.history.push({
      generation: state.generation,
      bestFitness: best.fitness,
      averageFitness: avg,
      bestDistance: best.metrics.distance,
      averageDistance: avgDist,
    });
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.replayGen = state.generation;
    deriveStatus();
    refreshInspector();
    refreshStats();
    refreshReplayControls();
    drawGraph();
  }

  function breedNext() {
    const next = createNextGeneration({ results: state.results!, config });
    state.population = next.population;
    state.results = null;
  }

  function buildSim() {
    state.sim?.destroy();
    state.sim = createPopulationSim(
      state.population.map((g) => builderFor(g)),
      terrain,
    );
    renderStatic();
  }

  function renderStatic() {
    if (!state.sim) return;
    view.render({
      items: state.sim.renderItems(),
      focusX: state.sim.leaderX(),
      ghost: state.showGhost ? ghostTrail : undefined,
      showJoints: state.showJoints,
      showCoM: state.showCoM,
    });
  }

  function seed(full: boolean) {
    state.population = createInitialPopulation(startLegs, config.populationSize);
    state.results = null;
    if (full) {
      state.generation = 0;
      state.champion = null;
      state.bestEver = null;
      state.champions = [];
      state.lastBest = null;
      state.history = [];
      state.lastImproveGen = 0;
      state.replayGen = 1;
      ghostTrail = [];
      raceTrail = [];
      state.statusSlug = "idle";
      state.statusText = "Idle — press Start";
    }
    buildSim();
    refreshInspector();
    refreshStats();
    refreshReplayControls();
    drawGraph();
  }

  // ------------------------------------------------------------- race loop
  function renderRace() {
    if (!state.sim) return;
    const items = state.sim.renderItems();
    const leader = items.find((it) => it.isLeader) ?? items[0];
    if (leader) {
      raceTrail.push({ x: leader.state.com.x, y: leader.state.com.y });
      if (raceTrail.length > 1600) raceTrail.shift();
    }
    view.render({
      items,
      focusX: state.sim.leaderX(),
      trail: raceTrail,
      ghost: state.showGhost ? ghostTrail : undefined,
      showJoints: state.showJoints,
      showCoM: state.showCoM,
    });
    liveDistStat.value.textContent = `${state.sim.bestMaxX().toFixed(1)} m`;
  }

  function finishRace() {
    if (state.isReplay) {
      state.isReplay = false;
      state.racing = false;
      buildSim(); // restore the current generation lineup
      syncButtons();
      return;
    }
    scoreGeneration(collectResults());
    if (state.showGhost) ghostTrail = raceTrail;
    raceTrail = [];
    const keepGoing = state.evolving && !state.stepOnce;
    breedNext();
    buildSim();
    if (keepGoing) {
      state.racing = true;
    } else {
      state.stepOnce = false;
      state.racing = false;
    }
    syncButtons();
  }

  function frame() {
    if (state.racing && !state.paused && state.sim) {
      const steps = Math.max(1, Math.round(state.replaySpeed));
      for (let i = 0; i < steps; i++) {
        state.sim.step();
        if (state.sim.time >= config.evaluationSeconds || state.sim.allDone())
          break;
      }
      renderRace();
      if (state.sim.time >= config.evaluationSeconds || state.sim.allDone())
        finishRace();
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
  function resetAll() {
    state.evolving = false;
    state.racing = false;
    state.stepOnce = false;
    state.isReplay = false;
    state.fastForwarding = false;
    state.paused = false;
    ffToken++; // cancel any in-flight fast-forward
    seed(true);
    syncButtons();
  }
  // Evolve `n` generations headlessly in the worker — no rendering, just breed.
  async function fastForward(n: number) {
    if (busy() || !compiled) return;
    const token = ++ffToken;
    state.fastForwarding = true;
    state.paused = false;
    syncButtons();
    for (let i = 0; i < n; i++) {
      if (token !== ffToken) return;
      const metrics = await evaluateInWorker(state.population);
      if (token !== ffToken) return;
      const results = state.population.map((genome, j) => ({
        genome,
        metrics: metrics[j],
        fitness: scoreMetrics(metrics[j]),
      }));
      scoreGeneration(results);
      breedNext();
    }
    if (token !== ffToken) return;
    state.fastForwarding = false;
    buildSim();
    syncButtons();
  }
  function replaySnapshot(snap: ChampionSnapshot | null) {
    if (!snap || busy()) return;
    state.sim?.destroy();
    state.sim = createPopulationSim([builderFor(snap.genome)], terrain);
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
  function changePlan(count: number) {
    startLegs = count;
    resetAll();
  }
  // Validate and (if valid) recompile the fitness expression. We deliberately do
  // NOT reset — watching the champion's behavior shift when you change the reward,
  // mid-run, is the whole lesson. `metricsUsed` drives which chips light up.
  function applyFitness(source: string) {
    fitnessSource = source;
    const v = validateFitness(source);
    if (v.ok) {
      compiled = v.compiled;
      fitnessStatus.textContent = "valid expression";
      fitnessStatus.setAttribute("data-ok", "true");
      const used = new Set<string>(v.metricsUsed);
      for (const [name, chip] of metricChips)
        chip.classList.toggle("es-chip--on", used.has(name));
    } else {
      compiled = null;
      fitnessStatus.textContent = v.error;
      fitnessStatus.setAttribute("data-ok", "false");
    }
    syncButtons(); // a broken expression must disable Start / Step / Evolve
    refreshStats();
  }

  // ------------------------------------------------------------- status
  function deriveStatus() {
    const be = state.bestEver;
    const lb = state.lastBest;
    if (config.mutationRate >= 0.2) {
      state.statusSlug = "high-mutation";
      state.statusText = "Too much mutation";
    } else if (be && be.metrics.distance >= WALKER_DISTANCE) {
      state.statusSlug = "walker";
      state.statusText = "Walker discovered";
    } else if (state.generation <= 1) {
      state.statusSlug = "chaos";
      state.statusText = "Random chaos";
    } else if (lb && lb.metrics.spinTime > lb.metrics.survivalTime * 0.4) {
      state.statusSlug = "spinning";
      state.statusText = "Mostly spinning";
    } else if (
      lb &&
      lb.metrics.bodyGroundContactTime > lb.metrics.survivalTime * 0.7
    ) {
      state.statusSlug = "dragging";
      state.statusText = "Mostly dragging";
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
    const value = el("span", { class: "ec-stat-value" }, "—");
    const row = el(
      "div",
      { class: "ec-stat" },
      el("span", { class: "ec-stat-label" }, label),
      value,
    );
    return { row, value };
  };
  const genStat = stat("generation");
  const bestFitStat = stat("best fitness");
  const avgFitStat = stat("avg fitness");
  const bestDistStat = stat("best distance");
  const avgDistStat = stat("avg distance");
  const bestSpeedStat = stat("best speed");
  const bestLegsStat = stat("best legs");
  const liveDistStat = stat("live distance");
  const terrainStat = stat("terrain");
  const statusBadge = el(
    "span",
    { class: "ec-status", "data-status": "idle" },
    "Idle",
  );

  // "Why did the champion win" — the additive terms of its fitness score. The
  // payoff of the DSL: it makes a spinning/dragging exploit visible as the term
  // that's quietly dominating.
  const breakdownWrap = el("div", { class: "es-breakdown" });
  function refreshBreakdown() {
    breakdownWrap.replaceChildren();
    if (!state.bestEver || !compiled) return;
    const items: FitnessBreakdownItem[] = breakdownFitness(
      compiled,
      state.bestEver.metrics,
    );
    for (const item of items) {
      breakdownWrap.append(
        el(
          "div",
          { class: "es-breakdown-row" },
          el("span", { class: "es-breakdown-label" }, item.label),
          el(
            "span",
            {
              class:
                item.value < 0 ? "es-breakdown-minus" : "es-breakdown-plus",
            },
            `${item.value >= 0 ? "+" : ""}${item.value.toFixed(1)}`,
          ),
        ),
      );
    }
    breakdownWrap.append(
      el(
        "div",
        { class: "es-breakdown-total" },
        el("span", {}, "total fitness"),
        el("span", {}, state.bestEver.fitness.toFixed(1)),
      ),
    );
  }

  function refreshStats() {
    genStat.value.textContent = String(state.generation);
    bestFitStat.value.textContent = state.bestEver
      ? state.bestEver.fitness.toFixed(1)
      : "—";
    const last = state.history[state.history.length - 1];
    avgFitStat.value.textContent = last ? last.averageFitness.toFixed(1) : "—";
    bestDistStat.value.textContent = state.bestEver
      ? `${state.bestEver.metrics.distance.toFixed(1)} m`
      : "—";
    avgDistStat.value.textContent = last
      ? `${last.averageDistance.toFixed(1)} m`
      : "—";
    bestSpeedStat.value.textContent = state.bestEver
      ? `${state.bestEver.metrics.averageSpeed.toFixed(2)} m/s`
      : "—";
    bestLegsStat.value.textContent = state.bestEver
      ? String(state.bestEver.genome.legCount)
      : "—";
    terrainStat.value.textContent = terrain.label;
    statusBadge.textContent = state.statusText;
    statusBadge.setAttribute("data-status", state.statusSlug);
    refreshBreakdown();
    updateExplanation();
  }

  // ------------------------------------------------------------- inspector
  // Rows are rebuilt on every refresh from the INSPECTED genome's own leg count —
  // a 6-legged champion and a 3-legged one show different gene sets, which is the
  // whole point once structure evolves.
  const currentBtn = el(
    "button",
    { type: "button", class: "ec-seg ec-seg--on" },
    "Current gen",
  );
  const bestBtn = el("button", { type: "button", class: "ec-seg" }, "Best ever");
  currentBtn.addEventListener("click", () => setInspectMode("current"));
  bestBtn.addEventListener("click", () => setInspectMode("best"));
  const inspectorSourceNote = el("p", { class: "ec-note" });
  const inspectorRowsWrap = el("div", {});
  const inspector = el(
    "div",
    { class: "ec-inspector" },
    el(
      "div",
      {
        class: "ec-seg-group",
        role: "group",
        "aria-label": "Which genome to inspect",
      },
      currentBtn,
      bestBtn,
    ),
    inspectorSourceNote,
    inspectorRowsWrap,
  );

  function setInspectMode(mode: InspectMode) {
    state.inspectMode = mode;
    currentBtn.classList.toggle("ec-seg--on", mode === "current");
    bestBtn.classList.toggle("ec-seg--on", mode === "best");
    refreshInspector();
  }
  function refreshInspector() {
    const snap =
      state.inspectMode === "best" ? state.bestEver : state.champion;
    const g = snap?.genome ?? null;
    inspectorSourceNote.textContent = snap
      ? `${
          state.inspectMode === "best" ? "Best ever" : "Best of generation"
        } ${snap.generation} — ${snap.genome.legCount} legs.`
      : "No champion yet — press Start.";
    inspectorRowsWrap.replaceChildren();
    const legCount = g ? g.legCount : startLegs;
    const genes = planGenes(legCount);
    for (const group of planGroups(legCount)) {
      inspectorRowsWrap.append(el("h4", { class: "ec-inspector-group" }, group));
      for (const spec of genes.filter((s) => s.group === group)) {
        const v = g ? g.values[spec.key] : undefined;
        inspectorRowsWrap.append(
          el(
            "div",
            { class: "ec-stat" },
            el("span", { class: "ec-stat-label" }, spec.label),
            el(
              "span",
              { class: "ec-stat-value" },
              v === undefined ? "—" : formatGene(spec, v),
            ),
          ),
        );
      }
    }
  }

  // ------------------------------------------------------------- graph
  const GW = 660;
  const GH = 150;
  const GP = 24;
  const graphBest = svg("polyline", { class: "ec-graph-best" });
  const graphAvg = svg("polyline", { class: "ec-graph-avg" });
  const graphSvg = svg(
    "svg",
    {
      viewBox: `0 0 ${GW} ${GH}`,
      class: "ec-graph",
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": "Best and average fitness per generation",
    },
    svg("line", {
      x1: GP,
      y1: GH - GP,
      x2: GW - GP,
      y2: GH - GP,
      class: "ec-graph-axis",
    }),
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
    const py = (f: number) =>
      GH - GP - ((f - minF) / (maxF - minF || 1)) * (GH - GP * 2);
    graphBest.setAttribute(
      "points",
      h
        .map((p) => `${px(p.generation).toFixed(1)},${py(p.bestFitness).toFixed(1)}`)
        .join(" "),
    );
    graphAvg.setAttribute(
      "points",
      h
        .map(
          (p) =>
            `${px(p.generation).toFixed(1)},${py(p.averageFitness).toFixed(1)}`,
        )
        .join(" "),
    );
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
    const valueEl = el("span", { class: "ec-slider-value" }, opts.format(opts.value));
    const input = el("input", {
      type: "range",
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: String(opts.value),
      class: "ec-slider-input",
      "aria-label": opts.label,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const v = Number(input.value);
      valueEl.textContent = opts.format(v);
      opts.onInput(v);
    });
    const field = el(
      "label",
      { class: "ec-field" },
      el("span", { class: "ec-field-head" }, el("span", {}, opts.label), valueEl),
      input,
    );
    return { field, input, valueEl };
  }

  const btn = (label: string, onClick: () => void, primary = false) =>
    el(
      "button",
      {
        type: "button",
        class: primary ? "ec-btn ec-btn--primary" : "ec-btn",
        onClick,
      },
      label,
    );

  const field = (label: string, control: HTMLElement) =>
    el(
      "label",
      { class: "ec-field" },
      el("span", { class: "ec-field-head" }, label),
      control,
    );

  const startBtn = btn("Start evolution", startEvolution, true);
  const pauseBtn = btn("Pause", pauseEvolution);
  const stepBtn = btn("Step gen", stepGeneration);
  const ffBtn = btn("Evolve ×25", () => fastForward(25));
  const resetBtn = btn("Reset", resetAll);
  const replayBestBtn = btn("Replay best ever", () =>
    replaySnapshot(state.bestEver),
  );
  const replayGenBtn = btn("Replay this gen", () =>
    replaySnapshot(state.champions[state.replayGen - 1] ?? null),
  );

  const replaySlider = slider({
    label: "Replay generation",
    min: 1,
    max: 1,
    step: 1,
    value: 1,
    format: (v) => `gen ${v}`,
    onInput: (v) => {
      state.replayGen = v;
    },
  });
  function refreshReplayControls() {
    const maxGen = Math.max(1, state.generation);
    replaySlider.input.max = String(maxGen);
    if (state.replayGen > maxGen) state.replayGen = maxGen;
    replaySlider.input.value = String(state.replayGen);
    replaySlider.valueEl.textContent = `gen ${state.replayGen}`;
    syncButtons();
  }

  function syncButtons() {
    const b = busy();
    startBtn.toggleAttribute("disabled", b || !compiled);
    pauseBtn.toggleAttribute("disabled", !state.racing || state.paused);
    stepBtn.toggleAttribute("disabled", b || !compiled);
    ffBtn.toggleAttribute("disabled", b || !compiled);
    resetBtn.toggleAttribute("disabled", false);
    replayBestBtn.toggleAttribute("disabled", !state.bestEver || b);
    replayGenBtn.toggleAttribute("disabled", state.generation === 0 || b);
    replaySlider.input.toggleAttribute("disabled", state.generation === 0);
  }

  const terrainSelect = el(
    "select",
    { class: "ec-select", name: "terrain", "aria-label": "Terrain" },
    ...terrains.map((t) => el("option", { value: t.id }, t.label)),
  ) as HTMLSelectElement;
  terrainSelect.value = terrain.id;
  terrainSelect.addEventListener("change", () =>
    changeTerrain(terrainSelect.value),
  );

  const planSelect = el(
    "select",
    { class: "ec-select", name: "plan", "aria-label": "Starting legs" },
    ...LEG_COUNTS.map((n) => el("option", { value: String(n) }, `${n} legs`)),
  ) as HTMLSelectElement;
  planSelect.value = String(startLegs);
  planSelect.addEventListener("change", () =>
    changePlan(Number(planSelect.value)),
  );

  // ---- fitness DSL panel --------------------------------------------------
  // A preset dropdown seeds the expression; the text box lets you rewrite it;
  // clicking a metric chip inserts its name. Editing recompiles live (no reset).
  const fitnessInput = el("input", {
    type: "text",
    class: "es-formula-input",
    name: "fitness-expression",
    "aria-label": "Fitness expression",
    spellcheck: "false",
    value: fitnessSource,
  }) as HTMLInputElement;
  const fitnessStatus = el("p", {
    class: "es-formula-status",
    "data-ok": "true",
  });
  fitnessInput.addEventListener("input", () => applyFitness(fitnessInput.value));

  const fitnessSelect = el(
    "select",
    { class: "ec-select", name: "fitness", "aria-label": "Fitness preset" },
    ...FITNESS_PRESETS.map((p) => el("option", { value: p.id }, p.label)),
  ) as HTMLSelectElement;
  fitnessSelect.value = DEFAULT_PRESET_ID;
  fitnessSelect.addEventListener("change", () => {
    const p = findPreset(fitnessSelect.value);
    fitnessInput.value = p.expression;
    applyFitness(p.expression);
  });

  // Clickable metric palette. Meaningless metrics (wheel contact — no wheels) are
  // dimmed. Clicking appends the metric name to the expression.
  const metricChips = new Map<string, HTMLElement>();
  const chipRow = el("div", { class: "es-chips" });
  for (const info of METRIC_CATALOG) {
    const dim = MEANINGLESS_METRICS.has(info.name);
    const chip = el(
      "button",
      {
        type: "button",
        class: dim ? "es-chip es-chip--dim" : "es-chip",
        title: info.help,
      },
      info.label,
    );
    chip.addEventListener("click", () => {
      const sep = fitnessInput.value.trim() ? " " : "";
      fitnessInput.value = `${fitnessInput.value.trimEnd()}${sep}${info.name}`;
      applyFitness(fitnessInput.value);
      fitnessInput.focus();
    });
    metricChips.set(info.name, chip);
    chipRow.append(chip);
  }

  const check = (
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
  ) => {
    const input = el("input", {
      type: "checkbox",
      class: "ec-check",
      name: label.toLowerCase().replace(/\s+/g, "-"),
      "aria-label": label,
    }) as HTMLInputElement;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { class: "ec-toggle" }, input, el("span", {}, label));
  };

  const controlsTab = el(
    "div",
    { class: "side-controls" },
    el(
      "div",
      { class: "ec-status-row" },
      el("span", { class: "ec-controls-title" }, "Status"),
      statusBadge,
    ),
    el(
      "div",
      { class: "ec-buttons" },
      startBtn,
      pauseBtn,
      stepBtn,
      ffBtn,
      resetBtn,
    ),
    el("div", { class: "ec-buttons" }, replayBestBtn, replayGenBtn),
    replaySlider.field,
    field("Starting legs", planSelect),
    field("Fitness preset", fitnessSelect),
    field("Fitness expression", fitnessInput),
    fitnessStatus,
    chipRow,
    field("Terrain", terrainSelect),
    slider({
      label: "Structural mutation",
      min: 0,
      max: 0.3,
      step: 0.01,
      value: config.structuralRate,
      format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => {
        config.structuralRate = v;
      },
    }).field,
    slider({
      label: "Population size",
      min: 10,
      max: 80,
      step: 2,
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
      max: 0.3,
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
      max: 0.4,
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
      max: 10,
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
      min: 6,
      max: 18,
      step: 1,
      value: config.evaluationSeconds,
      format: (v) => `${v}s`,
      onInput: (v) => {
        config.evaluationSeconds = v;
      },
    }).field,
    slider({
      label: "Sim speed",
      min: 1,
      max: 6,
      step: 1,
      value: state.replaySpeed,
      format: (v) => `${v}×`,
      onInput: (v) => {
        state.replaySpeed = v;
      },
    }).field,
    el(
      "div",
      { class: "ec-overlays" },
      check("Show previous-champion ghost", state.showGhost, (v) => {
        state.showGhost = v;
        renderStatic();
      }),
      check("Show joints", state.showJoints, (v) => {
        state.showJoints = v;
        renderStatic();
      }),
      check("Show center of mass", state.showCoM, (v) => {
        state.showCoM = v;
        renderStatic();
      }),
    ),
  );

  const statsTab = el(
    "div",
    {},
    el(
      "div",
      { class: "ec-stats" },
      genStat.row,
      liveDistStat.row,
      bestFitStat.row,
      avgFitStat.row,
      bestDistStat.row,
      avgDistStat.row,
      bestSpeedStat.row,
      bestLegsStat.row,
      terrainStat.row,
    ),
    el(
      "h4",
      { class: "ec-inspector-group" },
      "Why the champion won",
    ),
    breakdownWrap,
  );

  // ------------------------------------------------------------- explanation
  const explanationNote = el("p", { class: "ec-tip" });
  function updateExplanation() {
    explanationNote.textContent = deriveExplanationNote();
  }
  function deriveExplanationNote(): string {
    if (config.mutationRate >= 0.2)
      return "Mutation is high: the population explores aggressively but keeps scrambling promising gaits before they stabilize.";
    if (state.statusSlug === "spinning")
      return "Many bodies spin instead of walk — an easy way to game a distance reward. The spin penalty pushes back on it.";
    if (state.statusSlug === "dragging")
      return "Many bodies drag their belly along the ground. That still moves them, but it's not a clean gait.";
    if (state.statusSlug === "stuck")
      return "Progress has stalled. Try raising mutation to shake the population out of this local optimum.";
    if (config.structuralRate <= 0)
      return "Structural mutation is off: bodies keep their starting leg count and only their gaits evolve. Turn it up to let evolution add and drop limbs.";
    if (state.bestEver && state.bestEver.metrics.distance >= WALKER_DISTANCE)
      return "Something that genuinely walks has evolved. Watch the 'best legs' stat — evolution is choosing how many limbs to keep, not just how to swing them.";
    return "Random bodies flail on the ground. The few that happen to inch forward become parents, and their useful timing — and limb count — spreads.";
  }

  const explanation = el(
    "section",
    { class: "ec-explanation" },
    el("h3", {}, "What's happening?"),
    el(
      "p",
      {},
      "Every body is assembled by a generic ",
      el("strong", {}, "graph interpreter"),
      " from a genome — numbers describing the body, its limbs, and a ",
      el("strong", {}, "sine-wave motor"),
      " for each joint. The same interpreter builds any number of legs; nothing about the engine is hardcoded to a shape.",
    ),
    el(
      "p",
      {},
      "The whole population is tested on the ",
      el("strong", {}, "same ground"),
      " at once, scored by your chosen objective. The best become parents; ",
      el("strong", {}, "crossover"),
      " mixes whole limbs and ",
      el("strong", {}, "structural mutation"),
      " occasionally adds, duplicates, or drops a leg — so evolution reshapes the ",
      el("strong", {}, "body itself"),
      ", not just its gait.",
    ),
    explanationNote,
  );

  // ------------------------------------------------------------- layout
  const graphWrap = el(
    "div",
    { class: "ec-graph-wrap" },
    el(
      "div",
      { class: "ec-graph-head" },
      el("span", {}, "Fitness over generations"),
      el(
        "span",
        { class: "ec-graph-legend" },
        el("span", { class: "ec-legend ec-legend--best" }, "best"),
        el("span", { class: "ec-legend ec-legend--avg" }, "average"),
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
    { ariaLabel: "Evolving Morphology panel" },
  );

  const aside = el(
    "aside",
    { class: "concept-aside" },
    el(
      "div",
      { class: "concept-aside-head" },
      el("a", { href: "#/", class: "concept-back" }, "← All concepts"),
      el("h1", { class: "concept-title" }, "Evolving Morphology"),
      el(
        "p",
        { class: "concept-sub" },
        "One generic interpreter builds every body from a graph of parts — and evolution reshapes that graph, adding and dropping limbs on its own.",
      ),
    ),
    panel.el,
  );

  const page = el("div", { class: "concept-shell" }, stage, aside);

  document.body.classList.add("concept-open");
  root.replaceChildren(page);
  applyFitness(fitnessSource); // seed the status line + chip highlights
  seed(true);
  syncButtons();
  raf = requestAnimationFrame(frame);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    ffToken++;
    evalWorker.terminate();
    state.sim?.destroy();
    view.dispose();
    document.body.classList.remove("concept-open");
  };
}
