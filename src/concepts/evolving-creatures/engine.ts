// The Evolving Creatures engine. The whole population crawls together in one
// physics world (parts are collision-filtered so creatures pass through each
// other); when the generation's time is up they're scored, bred, and the next
// generation lines up. Idle is static — nothing moves until you press Start.
// "Evolve ×10" fast-forwards headlessly in a Web Worker so the main thread never
// locks. All evolution logic lives in the pure modules; this file drives them,
// renders, and owns the UI. Lazy-loaded by index.ts so planck only ships here.

import { el, svg } from "../../lib/dom.ts";
import { createTabPanel } from "../../lib/tabs.ts";
import {
  createInitialPopulation,
  GENE_GROUPS,
  GENES,
  geneRange,
} from "./genome.ts";
import { createNextCreatureGeneration, pickBest } from "./evolution.ts";
import type { EvalRequest, EvalResponse } from "./eval.worker.ts";
import { createCreatureView } from "./view.ts";
import { createPopulationSim, type PopulationSim } from "./physics.ts";
import { defaultTerrain, findTerrain, terrains } from "./terrain.ts";
import type {
  CreatureChampionSnapshot,
  CreatureEvaluationResult,
  CreatureGenome,
  EvolutionConfig,
  EvolutionHistoryPoint,
  GeneKey,
  Terrain,
} from "./types.ts";

const MAX_HISTORY = 400;
const CRAWLER_DISTANCE = 10; // metres of best reach that counts as "it crawls"

type StatusSlug =
  | "idle"
  | "chaos"
  | "improving"
  | "stuck"
  | "crawler"
  | "high-mutation"
  | "spinning"
  | "dragging";
type Pt = { x: number; y: number };
type InspectMode = "current" | "best";

function formatGene(key: GeneKey, v: number): string {
  const spec = geneRange(key);
  if (spec.display === "pi") return `${(v / Math.PI).toFixed(2)}π`;
  return spec.unit ? `${v.toFixed(2)} ${spec.unit}` : v.toFixed(2);
}

export function mount(root: HTMLElement): () => void {
  const config: EvolutionConfig = {
    populationSize: 30,
    eliteCount: 3,
    mutationRate: 0.06,
    mutationStrength: 0.12,
    crossoverRate: 0.9,
    tournamentSize: 3,
    evaluationSeconds: 10,
  };

  let terrain: Terrain = defaultTerrain;

  const state = {
    generation: 0,
    population: [] as CreatureGenome[],
    results: null as CreatureEvaluationResult[] | null,
    cached: [] as (CreatureEvaluationResult | null)[],
    champion: null as CreatureChampionSnapshot | null, // best of the last scored gen
    bestEver: null as CreatureChampionSnapshot | null,
    champions: [] as CreatureChampionSnapshot[], // one per generation, for the scrubber
    lastBest: null as CreatureEvaluationResult | null, // for status heuristics
    history: [] as EvolutionHistoryPoint[],
    lastImproveGen: 0,
    // run state
    sim: null as PopulationSim | null,
    evolving: false,
    racing: false,
    stepOnce: false,
    isReplay: false,
    paused: false,
    fastForwarding: false,
    replaySpeed: 2,
    showGhost: true,
    showJoints: false,
    showCoM: false,
    inspectMode: "current" as InspectMode,
    replayGen: 1,
    statusSlug: "idle" as StatusSlug,
    statusText: "Idle",
  };

  const view = createCreatureView();
  view.setTerrain(terrain);

  let raceTrail: Pt[] = [];
  let ghostTrail: Pt[] = [];
  let raf = 0;

  // Headless evaluation runs in a worker so fast-forward never blocks the main
  // thread. `ffToken` invalidates an in-flight fast-forward on reset/terrain-change.
  const evalWorker = new Worker(new URL("./eval.worker.ts", import.meta.url), {
    type: "module",
  });
  const evalPending = new Map<
    number,
    (results: CreatureEvaluationResult[]) => void
  >();
  let evalSeq = 0;
  let ffToken = 0;
  evalWorker.onmessage = (e: MessageEvent<EvalResponse>) => {
    const resolve = evalPending.get(e.data.id);
    if (resolve) {
      evalPending.delete(e.data.id);
      resolve(e.data.results);
    }
  };
  function evaluateInWorker(
    genomes: CreatureGenome[],
  ): Promise<CreatureEvaluationResult[]> {
    if (genomes.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = ++evalSeq;
      evalPending.set(id, resolve);
      const req: EvalRequest = { id, genomes, terrain, config };
      evalWorker.postMessage(req);
    });
  }

  const busy = () =>
    (state.racing && !state.paused) || state.fastForwarding || state.isReplay;

  // ------------------------------------------------------------- generations
  function snapshot(
    r: CreatureEvaluationResult,
    generation: number,
  ): CreatureChampionSnapshot {
    return {
      generation,
      genome: r.genome,
      fitness: r.fitness,
      maxX: r.maxX,
      averageVelocityX: r.averageVelocityX,
      terrainId: terrain.id,
    };
  }

  function scoreGeneration(results: CreatureEvaluationResult[]) {
    state.results = results;
    state.generation += 1;
    const best = pickBest(results);
    state.lastBest = best;
    state.champion = snapshot(best, state.generation);
    state.champions.push(state.champion);
    const avg = results.reduce((s, r) => s + r.fitness, 0) / results.length;
    const avgDist = results.reduce((s, r) => s + r.maxX, 0) / results.length;
    if (!state.bestEver || best.fitness > state.bestEver.fitness) {
      state.bestEver = state.champion;
      state.lastImproveGen = state.generation;
    }
    state.history.push({
      generation: state.generation,
      bestFitness: best.fitness,
      averageFitness: avg,
      bestDistance: best.maxX,
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
    const next = createNextCreatureGeneration({
      results: state.results!,
      config,
    });
    state.population = next.population;
    state.cached = next.cached;
    state.results = null;
  }

  function buildSim() {
    state.sim?.destroy();
    state.sim = createPopulationSim(state.population, terrain);
    renderStatic();
  }

  function renderStatic() {
    if (!state.sim) return;
    view.render({
      creatures: state.sim.renderItems(),
      focusX: state.sim.leaderX(),
      ghost: state.showGhost ? ghostTrail : undefined,
      showJoints: state.showJoints,
      showCoM: state.showCoM,
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
      creatures: items,
      focusX: state.sim.leaderX(),
      trail: raceTrail,
      ghost: state.showGhost ? ghostTrail : undefined,
      showJoints: state.showJoints,
      showCoM: state.showCoM,
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
  async function fastForward(n: number) {
    if (busy()) return;
    const token = ++ffToken;
    state.fastForwarding = true;
    state.racing = false;
    state.paused = false;
    syncButtons();

    for (let i = 0; i < n; i++) {
      if (token !== ffToken) return;
      if (state.results) breedNext();
      const freshGenomes: CreatureGenome[] = [];
      const cachedResults: CreatureEvaluationResult[] = [];
      for (let j = 0; j < state.population.length; j++) {
        const c = state.cached[j];
        if (c) cachedResults.push(c);
        else freshGenomes.push(state.population[j]);
      }
      const freshResults = await evaluateInWorker(freshGenomes);
      if (token !== ffToken) return;
      state.cached = [];
      scoreGeneration([...cachedResults, ...freshResults]);
    }

    if (token !== ffToken) return;
    state.fastForwarding = false;
    breedNext();
    buildSim();
    syncButtons();
  }
  function resetAll() {
    state.evolving = false;
    state.racing = false;
    state.stepOnce = false;
    state.isReplay = false;
    state.paused = false;
    state.fastForwarding = false;
    ffToken++;
    seed(true);
    syncButtons();
  }
  function replaySnapshot(snap: CreatureChampionSnapshot | null) {
    if (!snap || busy()) return;
    state.sim?.destroy();
    state.sim = createPopulationSim([snap.genome], terrain);
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
    const lb = state.lastBest;
    if (config.mutationRate >= 0.2) {
      state.statusSlug = "high-mutation";
      state.statusText = "Too much mutation";
    } else if (be && be.maxX >= CRAWLER_DISTANCE) {
      state.statusSlug = "crawler";
      state.statusText = "Crawler discovered";
    } else if (state.generation <= 1) {
      state.statusSlug = "chaos";
      state.statusText = "Random chaos";
    } else if (lb && lb.excessiveRotationSeconds > lb.timeAlive * 0.4) {
      state.statusSlug = "spinning";
      state.statusText = "Mostly spinning";
    } else if (lb && lb.bodyGroundContactSeconds > lb.timeAlive * 0.7) {
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
  const liveDistStat = stat("live distance");
  const terrainStat = stat("terrain");
  const statusBadge = el(
    "span",
    { class: "ec-status", "data-status": "idle" },
    "Idle",
  );

  function refreshStats() {
    genStat.value.textContent = String(state.generation);
    bestFitStat.value.textContent = state.bestEver
      ? state.bestEver.fitness.toFixed(1)
      : "—";
    const last = state.history[state.history.length - 1];
    avgFitStat.value.textContent = last ? last.averageFitness.toFixed(1) : "—";
    bestDistStat.value.textContent = state.bestEver
      ? `${state.bestEver.maxX.toFixed(1)} m`
      : "—";
    avgDistStat.value.textContent = last
      ? `${last.averageDistance.toFixed(1)} m`
      : "—";
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
  const currentBtn = el(
    "button",
    { type: "button", class: "ec-seg ec-seg--on" },
    "Current gen",
  );
  const bestBtn = el(
    "button",
    { type: "button", class: "ec-seg" },
    "Best ever",
  );
  currentBtn.addEventListener("click", () => setInspectMode("current"));
  bestBtn.addEventListener("click", () => setInspectMode("best"));
  const inspectorSourceNote = el("p", { class: "ec-note" });
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
  );
  for (const group of GENE_GROUPS) {
    inspector.append(el("h4", { class: "ec-inspector-group" }, group));
    for (const spec of GENES.filter((g) => g.group === group)) {
      const value = el("span", { class: "ec-stat-value" }, "—");
      inspectorRows.set(spec.key, value);
      inspector.append(
        el(
          "div",
          { class: "ec-stat" },
          el("span", { class: "ec-stat-label" }, spec.label),
          value,
        ),
      );
    }
  }
  function setInspectMode(mode: InspectMode) {
    state.inspectMode = mode;
    currentBtn.classList.toggle("ec-seg--on", mode === "current");
    bestBtn.classList.toggle("ec-seg--on", mode === "best");
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
      row.textContent = g ? formatGene(spec.key, g[spec.key]) : "—";
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
        .map(
          (p) =>
            `${px(p.generation).toFixed(1)},${py(p.bestFitness).toFixed(1)}`,
        )
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
    const valueEl = el(
      "span",
      { class: "ec-slider-value" },
      opts.format(opts.value),
    );
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
      el(
        "span",
        { class: "ec-field-head" },
        el("span", {}, opts.label),
        valueEl,
      ),
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
  const startBtn = btn("Start evolution", startEvolution, true);
  const pauseBtn = btn("Pause", pauseEvolution);
  const stepBtn = btn("Step gen", stepGeneration);
  const ffBtn = btn("Evolve ×10", () => fastForward(10));
  const resetBtn = btn("Reset", resetAll);
  const replayBestBtn = btn("Replay best ever", () =>
    replaySnapshot(state.bestEver),
  );
  const replayGenBtn = btn("Replay this gen", () =>
    replaySnapshot(state.champions[state.replayGen - 1] ?? null),
  );

  // Champion-history scrubber: pick any past generation and replay its champion.
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
    startBtn.toggleAttribute("disabled", b);
    pauseBtn.toggleAttribute("disabled", !state.racing || state.paused);
    stepBtn.toggleAttribute("disabled", b);
    ffBtn.toggleAttribute("disabled", b);
    resetBtn.toggleAttribute("disabled", false);
    replayBestBtn.toggleAttribute("disabled", !state.bestEver || b);
    replayGenBtn.toggleAttribute("disabled", state.generation === 0 || b);
    replaySlider.input.toggleAttribute("disabled", state.generation === 0);
  }

  const terrainSelect = el(
    "select",
    { class: "ec-select", "aria-label": "Terrain" },
    ...terrains.map((t) => el("option", { value: t.id }, t.label)),
  ) as HTMLSelectElement;
  terrainSelect.value = terrain.id;
  terrainSelect.addEventListener("change", () =>
    changeTerrain(terrainSelect.value),
  );

  const check = (
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
  ) => {
    const input = el("input", {
      type: "checkbox",
      class: "ec-check",
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
    field("Terrain", terrainSelect),
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
    { class: "ec-stats" },
    genStat.row,
    liveDistStat.row,
    bestFitStat.row,
    avgFitStat.row,
    bestDistStat.row,
    avgDistStat.row,
    bestSpeedStat.row,
    terrainStat.row,
  );

  // ------------------------------------------------------------- explanation
  const explanationNote = el("p", { class: "ec-tip" });
  function updateExplanation() {
    explanationNote.textContent = deriveExplanationNote();
  }
  function deriveExplanationNote(): string {
    if (config.mutationRate >= 0.2)
      return "Mutation is high: the population explores aggressively but keeps scrambling promising gaits before they stabilize.";
    if (config.mutationRate <= 0.01)
      return "Mutation is very low: good crawlers are preserved, but the population may stop discovering new movement patterns.";
    if (state.statusSlug === "spinning")
      return "Many creatures are spinning instead of crawling — an easy way to game a distance reward. The spin and energy penalties push back on it.";
    if (state.statusSlug === "dragging")
      return "Many creatures drag their body along the ground. That still moves them, but the dragging penalty nudges evolution toward cleaner steps.";
    if (state.statusSlug === "stuck")
      return "Progress has stalled. Try raising mutation to shake the population out of this local optimum.";
    if (state.bestEver && state.bestEver.maxX >= CRAWLER_DISTANCE)
      return "Something that genuinely crawls has evolved. Compare Current-gen vs Best-ever in the Genome tab to see which rhythms stuck.";
    return "Random bodies flail on the ground. The few that happen to inch forward become parents, and their useful timing spreads.";
  }

  const explanation = el(
    "section",
    { class: "ec-explanation" },
    el("h3", {}, "What's happening?"),
    el(
      "p",
      {},
      "Every creature is built from a ",
      el("strong", {}, "genome"),
      " — numbers describing its body, limb lengths, and a ",
      el("strong", {}, "sine-wave motor"),
      " for each joint. Nobody teaches it to walk; it's just born with a body and a rhythm.",
    ),
    el(
      "p",
      {},
      "The whole population is tested on the ",
      el("strong", {}, "same ground"),
      " at once (they pass through each other), scored on distance travelled, stability, and efficiency. The best become parents; ",
      el("strong", {}, "crossover"),
      " mixes traits and ",
      el("strong", {}, "mutation"),
      " nudges them. Over generations, accidental locomotion becomes slightly less accidental.",
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
    { ariaLabel: "Evolving Creatures panel" },
  );

  const aside = el(
    "aside",
    { class: "concept-aside" },
    el(
      "div",
      { class: "concept-aside-head" },
      el("a", { href: "#/", class: "concept-back" }, "← All concepts"),
      el("h1", { class: "concept-title" }, "Evolving Creatures"),
      el(
        "p",
        { class: "concept-sub" },
        "Tiny simulated creatures learn to crawl, flop, drag, and sometimes accidentally walk.",
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
    ffToken++;
    evalWorker.terminate();
    evalPending.clear();
    state.sim?.destroy();
    view.dispose();
    document.body.classList.remove("concept-open");
  };
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el(
    "label",
    { class: "ec-field" },
    el("span", { class: "ec-field-head" }, el("span", {}, label)),
    control,
  );
}
