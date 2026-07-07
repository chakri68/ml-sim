// The Genetic Algorithms visualization engine. Owns UI state, the step-by-step
// animation loop, controls, stats, the fitness graph, and the dynamic
// explanation. All genetic-algorithm logic lives in the pure ga.ts module; this
// file only drives it and renders. Loaded lazily by index.ts.

import { el, svg } from "../../lib/dom.ts";
import {
  createInitialPopulation,
  createNextGeneration,
  simulateAgent,
} from "./ga.ts";
import {
  defaultMaze,
  isSolvable,
  isWall,
  manhattan,
  randomMaze,
  withWall,
} from "./maze.ts";
import { createView, type ViewState } from "./view.ts";
import { createTabPanel } from "../../lib/tabs.ts";
import type {
  AgentResult,
  CrossoverMethod,
  FitnessHistoryPoint,
  GAConfig,
  GenerationStats,
  Genome,
  Maze,
  SelectionMethod,
} from "./types.ts";

const BASE_STEPS_PER_SEC = 14; // gene-advances per second at speed 1
const MAX_HISTORY = 300;
const OPTIMAL_PATH = 24; // BFS-known shortest route; used only for hints

const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

type StatusSlug =
  | "idle"
  | "exploring"
  | "improving"
  | "stuck"
  | "reached"
  | "optimizing"
  | "high-mutation";

export function mount(root: HTMLElement): () => void {
  let maze: Maze = defaultMaze;

  const config: GAConfig = {
    populationSize: 80,
    genomeLength: 90,
    mutationRate: 0.03,
    eliteCount: 2,
    tournamentSize: 3,
    selectionMethod: "tournament",
    crossoverMethod: "single",
  };

  const state = {
    speed: 2,
    generation: 0,
    genomes: [] as Genome[],
    results: [] as AgentResult[],
    geneIndex: 0,
    maxGeneLen: 0,
    bestIndex: 0,
    running: false,
    editing: false,
    solvable: true,
    statusSlug: "idle" as StatusSlug,
    statusText: "Idle",
    bestEver: null as { result: AgentResult; generation: number } | null,
    history: [] as FitnessHistoryPoint[],
    lastStats: null as GenerationStats | null,
  };

  const view = createView(maze, reducedMotion, {
    onCellClick: handleCellClick,
  });
  let raf = 0;
  let last = 0;
  let acc = 0;

  // --- maze editing / generation ------------------------------------------
  function handleCellClick(row: number, col: number) {
    if (!state.editing) return;
    if (row === maze.start.row && col === maze.start.col) return;
    if (row === maze.target.row && col === maze.target.col) return;
    maze = withWall(maze, row, col, !isWall(maze, row, col));
    state.solvable = isSolvable(maze);
    view.setMaze(maze);
    seed(true); // new maze = fresh problem
    setEditingStatus();
  }

  // Swap in a whole new maze (random / default) and start fresh on it.
  function loadMaze(next: Maze) {
    if (state.editing) exitEditMode();
    maze = next;
    state.solvable = isSolvable(maze);
    view.setMaze(maze);
    seed(true);
  }

  function setEditingStatus() {
    if (!state.solvable) {
      state.statusSlug = "high-mutation";
      state.statusText = "Maze unsolvable";
    } else {
      state.statusSlug = "idle";
      state.statusText = "Editing maze";
    }
    draw();
  }

  // --- generation lifecycle ------------------------------------------------
  function simulateGeneration() {
    state.results = state.genomes.map((g) => simulateAgent(g, maze));
    state.geneIndex = 0;
    state.maxGeneLen = state.results.reduce(
      (m, r) => Math.max(m, r.path.length - 1),
      0,
    );
    let bi = 0;
    for (let i = 1; i < state.results.length; i++) {
      if (state.results[i].fitness > state.results[bi].fitness) bi = i;
    }
    state.bestIndex = bi;
  }

  function seed(full: boolean) {
    stop();
    state.genomes = createInitialPopulation(config);
    if (full) {
      state.generation = 0;
      state.bestEver = null;
      state.history = [];
      state.lastStats = null;
      state.statusSlug = "idle";
      state.statusText = "Idle";
    }
    simulateGeneration();
    draw();
  }

  function finishGeneration() {
    const results = state.results;
    const n = results.length;
    const best = results[state.bestIndex];
    const avg = results.reduce((s, r) => s + r.fitness, 0) / n;
    const reachedResults = results.filter((r) => r.reachedTarget);
    const bestSteps = reachedResults.length
      ? Math.min(...reachedResults.map((r) => r.stepsTaken))
      : null;

    const stats: GenerationStats = {
      generation: state.generation,
      bestFitness: best.fitness,
      averageFitness: avg,
      bestDistance: Math.min(...results.map((r) => r.distance)),
      reachedTargetCount: reachedResults.length,
      bestSteps,
    };
    state.lastStats = stats;

    if (!state.bestEver || best.fitness > state.bestEver.result.fitness) {
      state.bestEver = { result: best, generation: state.generation };
    }

    state.history.push({
      generation: state.generation,
      bestFitness: best.fitness,
      averageFitness: avg,
    });
    if (state.history.length > MAX_HISTORY) state.history.shift();

    updateStatus(stats);

    // breed the next generation and roll forward
    state.genomes = createNextGeneration({ population: results, config });
    state.generation += 1;
    simulateGeneration();
  }

  function updateStatus(stats: GenerationStats) {
    const { text, slug } = deriveStatus(stats, config, state.history);
    state.statusText = text;
    state.statusSlug = slug;
  }

  // --- animation loop ------------------------------------------------------
  function draw() {
    const showAgents = showAgentsToggle.checked;
    const showBest = showBestToggle.checked;
    const agents: ViewState["agents"] = state.results.map((r, i) => {
      const idx = Math.min(state.geneIndex, r.path.length - 1);
      return {
        pos: r.path[idx],
        reachedTarget: r.reachedTarget && state.geneIndex >= r.reachedAtStep,
        isBest: i === state.bestIndex,
      };
    });
    view.update({
      agents,
      bestPath: state.bestEver?.result.path ?? null,
      showAgents,
      showBestPath: showBest,
    });
    refreshStats();
    drawGraph();
  }

  function frame(t: number) {
    if (!last) last = t;
    const dt = (t - last) / 1000;
    last = t;
    acc += dt * BASE_STEPS_PER_SEC * state.speed;
    let advanced = false;
    while (acc >= 1 && state.running) {
      acc -= 1;
      state.geneIndex += 1;
      advanced = true;
      if (state.geneIndex >= state.maxGeneLen) {
        finishGeneration();
      }
    }
    if (advanced) draw();
    if (state.running) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (state.running || state.editing || !state.solvable) return;
    state.running = true;
    if (state.statusSlug === "idle") {
      state.statusSlug = "exploring";
      state.statusText = "Exploring randomly";
    }
    last = 0;
    acc = 0;
    raf = requestAnimationFrame(frame);
    syncButtons();
    refreshStats();
  }

  function stop() {
    state.running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    syncButtons();
  }

  function stepGeneration() {
    if (state.editing || !state.solvable) return;
    stop();
    // fast-forward the current attempt, then breed — lands paused at gen start
    state.geneIndex = state.maxGeneLen;
    finishGeneration();
    draw();
  }

  // --- stats DOM -----------------------------------------------------------
  const stat = (label: string) => {
    const value = el("span", { class: "ga-stat-value" }, "—");
    const row = el(
      "div",
      { class: "ga-stat" },
      el("span", { class: "ga-stat-label" }, label),
      value,
    );
    return { row, value };
  };
  const genStat = stat("generation");
  const bestFitStat = stat("best fitness");
  const avgFitStat = stat("avg fitness");
  const bestDistStat = stat("best distance");
  const reachedStat = stat("reached target");
  const bestStepsStat = stat("shortest solve");
  const statusBadge = el(
    "span",
    { class: "ga-status", "data-status": "idle" },
    "Idle",
  );

  function refreshStats() {
    const s = state.lastStats;
    genStat.value.textContent = String(state.generation);
    bestFitStat.value.textContent = s ? s.bestFitness.toFixed(2) : "—";
    avgFitStat.value.textContent = s ? s.averageFitness.toFixed(2) : "—";
    bestDistStat.value.textContent = s
      ? String(s.bestDistance)
      : String(manhattan(maze.start, maze.target));
    reachedStat.value.textContent = s
      ? `${s.reachedTargetCount} / ${config.populationSize}`
      : `0 / ${config.populationSize}`;
    bestStepsStat.value.textContent =
      s && s.bestSteps != null ? `${s.bestSteps} steps` : "—";
    statusBadge.textContent = state.statusText;
    statusBadge.setAttribute("data-status", state.statusSlug);
    updateExplanationNote();
  }

  // --- fitness graph -------------------------------------------------------
  const GRAPH_W = 660;
  const GRAPH_H = 150;
  const GRAPH_PAD = 24;
  const graphBest = svg("polyline", { class: "ga-graph-best" });
  const graphAvg = svg("polyline", { class: "ga-graph-avg" });
  const graphSvg = svg(
    "svg",
    {
      viewBox: `0 0 ${GRAPH_W} ${GRAPH_H}`,
      class: "ga-graph",
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": "Best and average fitness per generation",
    },
    svg("line", {
      x1: GRAPH_PAD,
      y1: GRAPH_H - GRAPH_PAD,
      x2: GRAPH_W - GRAPH_PAD,
      y2: GRAPH_H - GRAPH_PAD,
      class: "ga-graph-axis",
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
    const maxFit = Math.max(...h.map((p) => p.bestFitness), 1);
    const gMin = h[0].generation;
    const gMax = h[h.length - 1].generation;
    const spanG = Math.max(1, gMax - gMin);
    const px = (g: number) =>
      GRAPH_PAD + ((g - gMin) / spanG) * (GRAPH_W - GRAPH_PAD * 2);
    const py = (f: number) =>
      GRAPH_H - GRAPH_PAD - (f / maxFit) * (GRAPH_H - GRAPH_PAD * 2);
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

  // --- controls ------------------------------------------------------------
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
      { class: "ga-slider-value" },
      opts.format(opts.value),
    );
    const input = el("input", {
      type: "range",
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: String(opts.value),
      class: "ga-slider-input",
      "aria-label": opts.label,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const v = Number(input.value);
      valueEl.textContent = opts.format(v);
      opts.onInput(v);
    });
    const field = el(
      "label",
      { class: "ga-field" },
      el(
        "span",
        { class: "ga-field-head" },
        el("span", {}, opts.label),
        valueEl,
      ),
      input,
    );
    return {
      field,
      setValue: (v: number) => {
        input.value = String(v);
        valueEl.textContent = opts.format(v);
      },
    };
  }

  const popSlider = slider({
    label: "Population size",
    min: 20,
    max: 300,
    step: 10,
    value: config.populationSize,
    format: (v) => String(v),
    onInput: (v) => {
      config.populationSize = v;
      seed(true); // structural change: restart
    },
  });
  const genomeSlider = slider({
    label: "Genome length",
    min: 20,
    max: 300,
    step: 10,
    value: config.genomeLength,
    format: (v) => String(v),
    onInput: (v) => {
      config.genomeLength = v;
      seed(true); // structural change: restart
    },
  });
  const mutationSlider = slider({
    label: "Mutation rate",
    min: 0,
    max: 0.3,
    step: 0.01,
    value: config.mutationRate,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      config.mutationRate = v;
      refreshStats();
    },
  });
  const eliteSlider = slider({
    label: "Elite count",
    min: 0,
    max: 20,
    step: 1,
    value: config.eliteCount,
    format: (v) => String(v),
    onInput: (v) => {
      config.eliteCount = v;
    },
  });
  const tournamentSlider = slider({
    label: "Tournament size",
    min: 2,
    max: 10,
    step: 1,
    value: config.tournamentSize,
    format: (v) => String(v),
    onInput: (v) => {
      config.tournamentSize = v;
    },
  });
  const speedSlider = slider({
    label: "Simulation speed",
    min: 0.5,
    max: 8,
    step: 0.5,
    value: state.speed,
    format: (v) => `${v}×`,
    onInput: (v) => {
      state.speed = v;
    },
  });

  // selection + crossover method selectors ---------------------------------
  const SELECTION_NOTES: Record<SelectionMethod, string> = {
    tournament:
      "Sample a few agents at random and keep the fittest. Robust and easy to explain.",
    roulette:
      "Fitness-proportionate: an agent's slice of the wheel is its fitness. Strong agents dominate fast.",
    rank: "Weight parents by their rank, not raw fitness — steadier when one agent's score runs away.",
  };
  const CROSSOVER_NOTES: Record<CrossoverMethod, string> = {
    single: "One cut: child is parent A up to the cut, then parent B.",
    "two-point": "Parent B fills a middle slice; A keeps both ends.",
    uniform:
      "Every gene is a coin flip between the two parents. Maximum mixing.",
  };

  function labelledSelect<T extends string>(
    label: string,
    options: Array<{ value: T; label: string }>,
    initial: T,
    onChange: (v: T) => void,
  ) {
    const sel = el(
      "select",
      { class: "ga-select", "aria-label": label },
      ...options.map((o) => el("option", { value: o.value }, o.label)),
    ) as HTMLSelectElement;
    sel.value = initial;
    const note = el("p", { class: "ga-note" });
    sel.addEventListener("change", () => onChange(sel.value as T));
    const field = el(
      "label",
      { class: "ga-field" },
      el("span", { class: "ga-field-head" }, el("span", {}, label)),
      sel,
      note,
    );
    return { field, note };
  }

  const selectionCtl = labelledSelect<SelectionMethod>(
    "Selection method",
    [
      { value: "tournament", label: "Tournament" },
      { value: "roulette", label: "Roulette (fitness)" },
      { value: "rank", label: "Rank" },
    ],
    config.selectionMethod,
    (v) => {
      config.selectionMethod = v;
      selectionCtl.note.textContent = SELECTION_NOTES[v];
      tournamentSlider.field.style.display = v === "tournament" ? "" : "none";
    },
  );
  selectionCtl.note.textContent = SELECTION_NOTES[config.selectionMethod];

  const crossoverCtl = labelledSelect<CrossoverMethod>(
    "Crossover method",
    [
      { value: "single", label: "Single-point" },
      { value: "two-point", label: "Two-point" },
      { value: "uniform", label: "Uniform" },
    ],
    config.crossoverMethod,
    (v) => {
      config.crossoverMethod = v;
      crossoverCtl.note.textContent = CROSSOVER_NOTES[v];
    },
  );
  crossoverCtl.note.textContent = CROSSOVER_NOTES[config.crossoverMethod];

  // toggles
  const showAgentsToggle = el("input", {
    type: "checkbox",
    class: "ga-check",
    checked: "true",
    "aria-label": "Show all agents",
  }) as HTMLInputElement;
  showAgentsToggle.checked = true;
  showAgentsToggle.addEventListener("change", draw);
  const showBestToggle = el("input", {
    type: "checkbox",
    class: "ga-check",
    "aria-label": "Show best path",
  }) as HTMLInputElement;
  showBestToggle.checked = true;
  showBestToggle.addEventListener("change", draw);

  // buttons
  const btn = (label: string, onClick: () => void, primary = false) =>
    el(
      "button",
      {
        type: "button",
        class: primary ? "ga-btn ga-btn--primary" : "ga-btn",
        onClick,
      },
      label,
    );
  const startBtn = btn("Start", start, true);
  const pauseBtn = btn("Pause", stop);
  const stepBtn = btn("Step generation", stepGeneration);
  const resetBtn = btn("Reset", () => seed(true));
  const randomBtn = btn("Randomize", () => seed(false));

  // maze buttons
  const randomMazeBtn = btn("Random maze", () => loadMaze(randomMaze()));
  const defaultMazeBtn = btn("Default maze", () => loadMaze(defaultMaze));
  const editBtn = btn("Edit maze", () => toggleEdit());

  function enterEditMode() {
    state.editing = true;
    stop();
    view.setEditMode(true);
    editBtn.textContent = "Done editing";
    editBtn.classList.add("ga-btn--on");
    setEditingStatus();
    syncButtons();
  }
  function exitEditMode() {
    state.editing = false;
    view.setEditMode(false);
    editBtn.textContent = "Edit maze";
    editBtn.classList.remove("ga-btn--on");
    state.statusSlug = state.solvable ? "idle" : "high-mutation";
    state.statusText = state.solvable ? "Idle" : "Maze unsolvable";
    draw();
    syncButtons();
  }
  function toggleEdit() {
    if (state.editing) exitEditMode();
    else enterEditMode();
  }

  function syncButtons() {
    const locked = state.editing || !state.solvable;
    startBtn.toggleAttribute("disabled", state.running || locked);
    pauseBtn.toggleAttribute("disabled", !state.running);
    stepBtn.toggleAttribute("disabled", locked);
  }

  // --- explanation ---------------------------------------------------------
  const explanationNote = el("p", { class: "ga-tip" });
  function updateExplanationNote() {
    explanationNote.textContent = deriveExplanationNote(config, state);
  }

  const explanation = el(
    "section",
    { class: "ga-explanation" },
    el("h3", {}, "What's happening?"),
    el(
      "p",
      {},
      "A genetic algorithm keeps a whole ",
      el("strong", {}, "population"),
      " of candidate solutions. Here each agent carries a ",
      el("strong", {}, "genome"),
      " — a fixed list of moves it replays blindly. None of them can see the maze.",
    ),
    el(
      "p",
      {},
      "After every generation, agents are scored by how close they got (",
      el("strong", {}, "fitness"),
      "). Fitter agents are more likely to become parents; their genomes are mixed with ",
      el("strong", {}, "crossover"),
      " and nudged with ",
      el("strong", {}, "mutation"),
      ", while ",
      el("strong", {}, "elitism"),
      " copies the best few through untouched. Useful move patterns survive and spread.",
    ),
    explanationNote,
  );

  // --- layout --------------------------------------------------------------
  const graphWrap = el(
    "div",
    { class: "ga-graph-wrap" },
    el(
      "div",
      { class: "ga-graph-head" },
      el("span", {}, "Fitness over generations"),
      el(
        "span",
        { class: "ga-graph-legend" },
        el("span", { class: "ga-legend ga-legend--best" }, "best"),
        el("span", { class: "ga-legend ga-legend--avg" }, "average"),
      ),
    ),
    graphSvg,
  );

  const stageMain = el("div", { class: "concept-stage-main" }, view.el);
  const stage = el(
    "div",
    { class: "concept-stage" },
    stageMain,
    el("div", { class: "concept-stage-foot" }, graphWrap),
  );

  const controls = el(
    "div",
    { class: "side-controls" },
    el(
      "div",
      { class: "ga-status-row" },
      el("span", { class: "ga-controls-title" }, "Status"),
      statusBadge,
    ),
    el(
      "div",
      { class: "ga-buttons" },
      startBtn,
      pauseBtn,
      stepBtn,
      resetBtn,
      randomBtn,
    ),
    el(
      "div",
      { class: "ga-buttons ga-buttons--maze" },
      randomMazeBtn,
      defaultMazeBtn,
      editBtn,
    ),
    popSlider.field,
    genomeSlider.field,
    mutationSlider.field,
    eliteSlider.field,
    selectionCtl.field,
    tournamentSlider.field,
    crossoverCtl.field,
    speedSlider.field,
    el(
      "div",
      { class: "ga-toggles" },
      el(
        "label",
        { class: "ga-toggle" },
        showAgentsToggle,
        el("span", {}, "Show all agents"),
      ),
      el(
        "label",
        { class: "ga-toggle" },
        showBestToggle,
        el("span", {}, "Show best path"),
      ),
    ),
    el(
      "div",
      { class: "ga-stats" },
      genStat.row,
      bestFitStat.row,
      avgFitStat.row,
      bestDistStat.row,
      reachedStat.row,
      bestStepsStat.row,
    ),
  );

  const panel = createTabPanel(
    [
      { id: "controls", label: "Controls", content: controls },
      { id: "notes", label: "Notes", content: explanation },
    ],
    { ariaLabel: "Genetic algorithms panel" },
  );

  const aside = el(
    "aside",
    { class: "concept-aside" },
    el(
      "div",
      { class: "concept-aside-head" },
      el("a", { href: "#/", class: "concept-back" }, "← All concepts"),
      el("h1", { class: "concept-title" }, "Genetic Algorithms"),
      el(
        "p",
        { class: "concept-sub" },
        "None of these agents know the maze. Watch a population evolve from random flailing into a path — survival of the least stupid.",
      ),
    ),
    panel.el,
  );

  const page = el("div", { class: "concept-shell" }, stage, aside);

  document.body.classList.add("concept-open");
  root.replaceChildren(page);
  seed(true);
  syncButtons();

  return () => {
    stop();
    view.dispose();
    document.body.classList.remove("concept-open");
  };
}

// --- pure helpers ----------------------------------------------------------

function deriveStatus(
  stats: GenerationStats,
  config: GAConfig,
  history: FitnessHistoryPoint[],
): { text: string; slug: StatusSlug } {
  if (stats.reachedTargetCount > 0) {
    if (stats.bestSteps != null && stats.bestSteps <= OPTIMAL_PATH + 6) {
      return { text: "Optimizing path", slug: "optimizing" };
    }
    return { text: "Target reached", slug: "reached" };
  }
  if (config.mutationRate >= 0.2) {
    return { text: "Too much mutation", slug: "high-mutation" };
  }
  // plateau check over the last handful of generations
  if (history.length >= 6) {
    const recent = history.slice(-6);
    const delta = recent[recent.length - 1].bestFitness - recent[0].bestFitness;
    if (delta < 0.25) return { text: "Stuck", slug: "stuck" };
  }
  if (history.length >= 2) {
    const prev = history[history.length - 2].bestFitness;
    if (stats.bestFitness > prev + 0.01) {
      return { text: "Improving", slug: "improving" };
    }
  }
  return { text: "Exploring randomly", slug: "exploring" };
}

function deriveExplanationNote(
  config: GAConfig,
  state: {
    bestEver: { result: AgentResult } | null;
    generation: number;
    editing: boolean;
    solvable: boolean;
  },
): string {
  if (state.editing) {
    return state.solvable
      ? "Editing: click any cell to add or remove a wall. The population restarts on the new maze. Hit “Done editing” to run it."
      : "This maze has no route from S to T right now — the target is walled off. Clear a wall to reconnect them.";
  }
  if (!state.solvable) {
    return "The current maze is unsolvable: there's no open path from start to target. Edit it or load a different maze.";
  }
  if (config.mutationRate === 0) {
    return "Mutation is off. The population can only recombine existing moves, so it often gets stuck once everyone looks alike.";
  }
  if (config.mutationRate >= 0.2) {
    return "Mutation is very high, so children keep scrambling useful paths before they can stabilize. Try lowering it toward 3–5%.";
  }
  if (state.bestEver?.result.reachedTarget) {
    return "An agent reached the target. Now selection favors shorter, cleaner solves — watch the best path tighten up.";
  }
  if (config.genomeLength < OPTIMAL_PATH + 4) {
    return "Heads up: the genome may be too short to physically reach the target from the start. Try increasing genome length.";
  }
  return "Better attempts keep getting reused, so the population drifts closer to the target even though no single agent can see it.";
}
