// The Evolution Sandbox engine. It reuses the whole-population-in-one-world race
// and the worker fast-forward from Evolving Creatures, but the body, the search
// space, and the fitness function are all user-chosen: pick a template, edit the
// gene ranges (the search space), write a fitness expression (what "better"
// means), and run. Everything downstream — evolution, physics, view — is
// template-agnostic. Lazy-loaded by index.ts so planck only ships here.

import { el, svg } from "../../lib/dom.ts";
import { createTabPanel } from "../../lib/tabs.ts";
import { clamp } from "../../lib/math.ts";
import { METRIC_CATALOG } from "./metrics.ts";
import {
  compileFitness,
  validateFitness,
  type CompiledFitness,
} from "./fitnessDsl.ts";
import { FITNESS_PRESETS, findPreset } from "./fitnessPresets.ts";
import { createInitialPopulation, makeBlueprint } from "./genome.ts";
import { createNextGeneration, pickBest } from "./evolution.ts";
import { scoreRaw } from "./evaluate.ts";
import { createPopulationSim, type PopulationSim } from "./physics.ts";
import { createSandboxView } from "./view.ts";
import { defaultTemplate, findTemplate, templates } from "./templates/index.ts";
import { defaultTerrain, findTerrain, terrains } from "./terrain.ts";
import {
  buildExperiment,
  parseExperiment,
  serializeExperiment,
} from "./experiment.ts";
import type { EvalRequest, EvalResponse } from "./eval.worker.ts";
import type {
  Blueprint,
  ChampionSnapshot,
  EvolutionConfig,
  EvolutionHistoryPoint,
  Genome,
  SandboxEvaluationResult,
  Template,
  Terrain,
} from "./types.ts";

const MAX_HISTORY = 400;

type StatusSlug =
  "idle" | "chaos" | "improving" | "stuck" | "high-mutation" | "no-signal";
type Pt = { x: number; y: number };

function formatGene(
  display: "num" | "pi" | undefined,
  unit: string | undefined,
  v: number,
): string {
  if (display === "pi") return `${(v / Math.PI).toFixed(2)}π`;
  return unit ? `${v.toFixed(2)} ${unit}` : v.toFixed(2);
}

export function mount(root: HTMLElement): () => void {
  const config: EvolutionConfig = {
    populationSize: 40,
    eliteCount: 4,
    mutationRate: 0.06,
    mutationStrength: 1,
    crossoverRate: 0.9,
    tournamentSize: 3,
    evaluationSeconds: 12,
  };

  let template: Template = defaultTemplate;
  let blueprint: Blueprint = makeBlueprint(template);
  let terrain: Terrain = defaultTerrain;
  let fitnessSource =
    findPreset(template.recommendedFitness)?.expression ?? "distance * 10";
  let compiled: CompiledFitness | null = compileFitness(fitnessSource);
  let fitnessError: string | null = null;

  const state = {
    generation: 0,
    population: [] as Genome[],
    results: null as SandboxEvaluationResult[] | null,
    cached: [] as (SandboxEvaluationResult | null)[],
    champion: null as ChampionSnapshot | null,
    bestEver: null as ChampionSnapshot | null,
    champions: [] as ChampionSnapshot[],
    lastBest: null as SandboxEvaluationResult | null,
    history: [] as EvolutionHistoryPoint[],
    lastImproveGen: 0,
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
    replayGen: 1,
    statusSlug: "idle" as StatusSlug,
    statusText: "Idle",
  };

  const view = createSandboxView();
  view.setTerrain(terrain);

  let raceTrail: Pt[] = [];
  let ghostTrail: Pt[] = [];
  let raf = 0;

  // ---------------------------------------------------------------- worker
  const evalWorker = new Worker(new URL("./eval.worker.ts", import.meta.url), {
    type: "module",
  });
  const evalPending = new Map<number, (r: EvalResponse) => void>();
  let evalSeq = 0;
  let ffToken = 0;
  evalWorker.onmessage = (e: MessageEvent<EvalResponse>) => {
    const resolve = evalPending.get(e.data.id);
    if (resolve) {
      evalPending.delete(e.data.id);
      resolve(e.data);
    }
  };
  function evaluateInWorker(genomes: Genome[]): Promise<EvalResponse> {
    if (genomes.length === 0)
      return Promise.resolve({ id: -1, ok: true, results: [] });
    return new Promise((resolve) => {
      const id = ++evalSeq;
      evalPending.set(id, resolve);
      const req: EvalRequest = {
        id,
        templateId: template.id,
        terrainId: terrain.id,
        fitnessSource,
        genomes,
        config,
      };
      evalWorker.postMessage(req);
    });
  }

  const busy = () =>
    (state.racing && !state.paused) || state.fastForwarding || state.isReplay;
  const canRun = () => compiled !== null && fitnessError === null;

  // ---------------------------------------------------------------- scoring
  function scoreLive(): SandboxEvaluationResult[] {
    const raw = state.sim!.rawResults();
    return raw.map((r) => scoreRaw(r, compiled!));
  }

  function snapshot(
    r: SandboxEvaluationResult,
    generation: number,
  ): ChampionSnapshot {
    return {
      generation,
      genome: r.genome,
      fitness: r.fitness,
      metrics: r.metrics,
      breakdown: r.breakdown,
      templateId: template.id,
      terrainId: terrain.id,
    };
  }

  function scoreGeneration(results: SandboxEvaluationResult[]) {
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
    refreshStats();
    refreshBreakdown();
    refreshReplayControls();
    drawGraph();
  }

  function breedNext() {
    const next = createNextGeneration({
      template,
      ranges: blueprint.ranges,
      results: state.results!,
      config,
    });
    state.population = next.population;
    state.cached = next.cached;
    state.results = null;
  }

  function buildSim() {
    state.sim?.destroy();
    state.sim = createPopulationSim(template, state.population, terrain);
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
    state.population = createInitialPopulation(
      template,
      blueprint.ranges,
      config.populationSize,
    );
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
    refreshStats();
    refreshBreakdown();
    refreshReplayControls();
    drawGraph();
  }

  // ---------------------------------------------------------------- race loop
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
      buildSim();
      syncButtons();
      return;
    }
    scoreGeneration(scoreLive());
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

  // ---------------------------------------------------------------- actions
  function startEvolution() {
    if (busy() || !canRun()) return;
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
    if (busy() || !canRun()) return;
    state.evolving = false;
    state.stepOnce = true;
    state.racing = true;
    state.paused = false;
    syncButtons();
  }
  async function fastForward(n: number) {
    if (busy() || !canRun()) return;
    const token = ++ffToken;
    state.fastForwarding = true;
    state.racing = false;
    state.paused = false;
    syncButtons();

    for (let i = 0; i < n; i++) {
      if (token !== ffToken) return;
      if (state.results) breedNext();
      const freshGenomes: Genome[] = [];
      const cachedResults: SandboxEvaluationResult[] = [];
      for (let j = 0; j < state.population.length; j++) {
        const c = state.cached[j];
        if (c) cachedResults.push(c);
        else freshGenomes.push(state.population[j]);
      }
      const resp = await evaluateInWorker(freshGenomes);
      if (token !== ffToken) return;
      if (!resp.ok) {
        fitnessError = resp.error;
        refreshFitnessStatus();
        break;
      }
      state.cached = [];
      scoreGeneration([...cachedResults, ...resp.results]);
    }

    if (token !== ffToken) return;
    state.fastForwarding = false;
    if (state.results) breedNext();
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
  function replaySnapshot(snap: ChampionSnapshot | null) {
    if (!snap || busy()) return;
    state.sim?.destroy();
    state.sim = createPopulationSim(template, [snap.genome], terrain);
    raceTrail = [];
    state.isReplay = true;
    state.racing = true;
    state.paused = false;
    syncButtons();
  }

  // ---------------------------------------------------------------- changes
  function changeTemplate(id: string) {
    template = findTemplate(id);
    blueprint = makeBlueprint(template);
    const preset = findPreset(template.recommendedFitness);
    if (preset) {
      fitnessSource = preset.expression;
      formulaInput.value = fitnessSource;
      recompileFitness();
    }
    rebuildGenePanel();
    rebuildMetricChips();
    rebuildTemplateCards();
    resetAll();
  }
  function changeTerrain(id: string) {
    terrain = findTerrain(id);
    view.setTerrain(terrain);
    resetAll();
  }
  function recompileFitness() {
    const v = validateFitness(fitnessSource);
    if (v.ok) {
      compiled = v.compiled;
      fitnessError = null;
    } else {
      compiled = null;
      fitnessError = v.error;
    }
    refreshFitnessStatus();
    refreshMetricChips();
    syncButtons();
  }

  // ---------------------------------------------------------------- status
  function deriveStatus() {
    if (config.mutationRate >= 0.2) {
      state.statusSlug = "high-mutation";
      state.statusText = "Too much mutation";
      return;
    }
    const h = state.history;
    const last = h[h.length - 1];
    if (
      last &&
      Math.abs(last.bestFitness - last.averageFitness) < 1e-6 &&
      h.length >= 2
    ) {
      state.statusSlug = "no-signal";
      state.statusText = "No fitness signal";
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

  // ---------------------------------------------------------------- stats DOM
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
  const liveDistStat = stat("live distance");
  const templateStat = stat("template");
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
      ? `${state.bestEver.metrics.distance.toFixed(1)} m`
      : "—";
    avgDistStat.value.textContent = last
      ? `${last.averageDistance.toFixed(1)} m`
      : "—";
    templateStat.value.textContent = template.label;
    terrainStat.value.textContent = terrain.label;
    statusBadge.textContent = state.statusText;
    statusBadge.setAttribute("data-status", state.statusSlug);
  }

  // ---------------------------------------------------------------- fitness UI
  const formulaInput = el("textarea", {
    class: "es-formula-input",
    rows: "3",
    spellcheck: "false",
    "aria-label": "Fitness expression",
  }) as HTMLTextAreaElement;
  formulaInput.value = fitnessSource;
  formulaInput.addEventListener("input", () => {
    fitnessSource = formulaInput.value;
    recompileFitness();
  });

  const fitnessStatus = el("p", { class: "es-formula-status" });
  function refreshFitnessStatus() {
    if (fitnessError) {
      fitnessStatus.textContent = `✗ ${fitnessError}`;
      fitnessStatus.setAttribute("data-ok", "false");
    } else {
      fitnessStatus.textContent = "✓ Valid expression";
      fitnessStatus.setAttribute("data-ok", "true");
    }
  }

  const presetSelect = el(
    "select",
    { class: "ec-select", "aria-label": "Fitness preset" },
    el("option", { value: "" }, "Presets…"),
    ...FITNESS_PRESETS.map((p) => el("option", { value: p.id }, p.label)),
  ) as HTMLSelectElement;
  const presetNote = el("p", { class: "ec-note" });
  presetSelect.addEventListener("change", () => {
    const p = findPreset(presetSelect.value);
    if (!p) return;
    fitnessSource = p.expression;
    formulaInput.value = fitnessSource;
    presetNote.textContent = p.note;
    recompileFitness();
  });

  const metricChipWrap = el("div", { class: "es-chips" });
  function insertMetric(name: string) {
    const start = formulaInput.selectionStart ?? formulaInput.value.length;
    const end = formulaInput.selectionEnd ?? formulaInput.value.length;
    const before = formulaInput.value.slice(0, start);
    const after = formulaInput.value.slice(end);
    const sep = before && !/[\s(]$/.test(before) ? " " : "";
    formulaInput.value = `${before}${sep}${name}${after}`;
    fitnessSource = formulaInput.value;
    formulaInput.focus();
    const caret = (before + sep + name).length;
    formulaInput.setSelectionRange(caret, caret);
    recompileFitness();
  }
  function rebuildMetricChips() {
    const meaningful = new Set<string>(template.meaningfulMetrics);
    metricChipWrap.replaceChildren(
      ...METRIC_CATALOG.map((m) => {
        const usable = meaningful.has(m.name);
        const chip = el(
          "button",
          {
            type: "button",
            class: usable ? "es-chip" : "es-chip es-chip--dim",
            title: usable
              ? m.help
              : `${m.help} (Always 0 for ${template.label}.)`,
          },
          m.label,
        );
        chip.addEventListener("click", () => insertMetric(m.name));
        return chip;
      }),
    );
  }
  function refreshMetricChips() {
    const used = new Set(compiled ? metricsUsedIn(fitnessSource) : []);
    for (const chip of Array.from(metricChipWrap.children) as HTMLElement[]) {
      chip.classList.toggle("es-chip--on", used.has(chip.textContent ?? ""));
    }
  }
  function metricsUsedIn(src: string): string[] {
    const v = validateFitness(src);
    return v.ok ? v.metricsUsed : [];
  }

  // fitness breakdown (why the champion won)
  const breakdownWrap = el("div", { class: "es-breakdown" });
  function refreshBreakdown() {
    const champ = state.bestEver;
    if (!champ) {
      breakdownWrap.replaceChildren(
        el(
          "p",
          { class: "ec-note" },
          "Run evolution to see why the champion scored what it did.",
        ),
      );
      return;
    }
    const rows = champ.breakdown.map((item) =>
      el(
        "div",
        { class: "es-breakdown-row" },
        el("span", { class: "es-breakdown-label" }, item.label),
        el(
          "span",
          {
            class: item.value >= 0 ? "es-breakdown-plus" : "es-breakdown-minus",
          },
          `${item.value >= 0 ? "+" : ""}${item.value.toFixed(1)}`,
        ),
      ),
    );
    breakdownWrap.replaceChildren(
      el(
        "div",
        { class: "es-breakdown-total" },
        el("span", {}, "Fitness"),
        el("span", {}, champ.fitness.toFixed(1)),
      ),
      ...rows,
      el("p", { class: "ec-tip" }, breakdownInsight(champ)),
    );
  }
  function breakdownInsight(champ: ChampionSnapshot): string {
    if (!champ.breakdown.length) return "";
    const top = [...champ.breakdown].sort(
      (a, b) => Math.abs(b.value) - Math.abs(a.value),
    )[0];
    const drivenBy = top.label.replace(/^-/, "");
    return `This design won mostly because of "${drivenBy}". Change its weight — or add a penalty — and watch the winning behaviour change.`;
  }

  // ---------------------------------------------------------------- gene panel
  const genePanel = el("div", { class: "es-genes" });
  function rangeRow(spec: Template["genes"][number]) {
    const r = blueprint.ranges[spec.key];
    const num = (
      value: number,
      onChange: (v: number) => void,
      label: string,
    ) => {
      const input = el("input", {
        type: "number",
        class: "es-num",
        value: String(round3(value)),
        step: "0.05",
        "aria-label": `${spec.label} ${label}`,
      }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) onChange(v);
      });
      return input;
    };
    const minInput = num(
      r.min,
      (v) => {
        r.min = clamp(v, spec.min, r.max);
        minInput.value = String(round3(r.min));
        resetAll();
      },
      "min",
    );
    const maxInput = num(
      r.max,
      (v) => {
        r.max = clamp(v, r.min, spec.max);
        maxInput.value = String(round3(r.max));
        resetAll();
      },
      "max",
    );
    const mutable = el("input", {
      type: "checkbox",
      class: "ec-check",
      "aria-label": `${spec.label} mutable`,
    }) as HTMLInputElement;
    mutable.checked = r.mutable;
    mutable.addEventListener("change", () => {
      r.mutable = mutable.checked;
      resetAll();
    });
    return el(
      "div",
      { class: "es-gene-row" },
      el(
        "span",
        {
          class: "es-gene-name",
          title: `Hard bounds ${formatGene(spec.display, spec.unit, spec.min)} – ${formatGene(spec.display, spec.unit, spec.max)}`,
        },
        spec.label,
      ),
      el("label", { class: "es-gene-field" }, el("span", {}, "min"), minInput),
      el("label", { class: "es-gene-field" }, el("span", {}, "max"), maxInput),
      el("label", { class: "es-gene-mut" }, mutable, el("span", {}, "mut")),
    );
  }
  function rebuildGenePanel() {
    const nodes: HTMLElement[] = [
      el(
        "p",
        { class: "ec-note" },
        "Edit each gene's search window — the range evolution samples and mutates within. You're designing the search space. Editing a range restarts evolution.",
      ),
    ];
    for (const group of template.geneGroups) {
      nodes.push(el("h4", { class: "ec-inspector-group" }, group));
      for (const spec of template.genes.filter((g) => g.group === group))
        nodes.push(rangeRow(spec));
    }
    genePanel.replaceChildren(...nodes);
  }

  // ---------------------------------------------------------------- template cards
  const templateCardWrap = el("div", { class: "es-template-cards" });
  function rebuildTemplateCards() {
    templateCardWrap.replaceChildren(
      ...templates.map((t) => {
        const card = el(
          "button",
          {
            type: "button",
            class:
              t.id === template.id
                ? "es-template-card es-template-card--on"
                : "es-template-card",
          },
          el("span", { class: "es-template-title" }, t.label),
          el("span", { class: "es-template-sub" }, t.subtitle),
        );
        card.addEventListener("click", () => {
          if (t.id !== template.id && !busy()) changeTemplate(t.id);
        });
        return card;
      }),
    );
  }

  // ---------------------------------------------------------------- graph
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

  // ---------------------------------------------------------------- controls
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
  const exportBtn = btn("Export JSON", exportExperiment);
  const importBtn = btn("Import JSON", () => fileInput.click());

  const fileInput = el("input", {
    type: "file",
    accept: "application/json,.json",
    style: { display: "none" },
  }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    file.text().then(importExperiment);
    fileInput.value = "";
  });

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
    startBtn.toggleAttribute("disabled", b || !canRun());
    pauseBtn.toggleAttribute("disabled", !state.racing || state.paused);
    stepBtn.toggleAttribute("disabled", b || !canRun());
    ffBtn.toggleAttribute("disabled", b || !canRun());
    resetBtn.toggleAttribute("disabled", false);
    replayBestBtn.toggleAttribute("disabled", !state.bestEver || b);
    replayGenBtn.toggleAttribute("disabled", state.generation === 0 || b);
    replaySlider.input.toggleAttribute("disabled", state.generation === 0);
    exportBtn.toggleAttribute("disabled", b);
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

  function fieldLabel(label: string, control: HTMLElement): HTMLElement {
    return el(
      "label",
      { class: "ec-field" },
      el("span", { class: "ec-field-head" }, el("span", {}, label)),
      control,
    );
  }

  // ---------------------------------------------------------------- export/import
  function exportExperiment() {
    const exp = buildExperiment({
      name: `${template.label} — ${terrain.label}`,
      blueprint,
      fitnessExpression: fitnessSource,
      terrainId: terrain.id,
      config,
    });
    const blob = new Blob([serializeExperiment(exp)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: `sandbox-${template.id}.json` });
    a.click();
    URL.revokeObjectURL(url);
  }
  function importExperiment(json: string) {
    const res = parseExperiment(json);
    if (!res.ok) {
      fitnessStatus.textContent = `✗ Import failed: ${res.error}`;
      fitnessStatus.setAttribute("data-ok", "false");
      panel.select("fitness");
      return;
    }
    const exp = res.experiment;
    template = findTemplate(exp.templateId);
    blueprint = { templateId: exp.templateId, ranges: exp.ranges };
    terrain = findTerrain(exp.terrainId);
    view.setTerrain(terrain);
    Object.assign(config, exp.config);
    fitnessSource = exp.fitnessExpression;
    formulaInput.value = fitnessSource;
    terrainSelect.value = terrain.id;
    syncConfigSliders();
    recompileFitness();
    rebuildGenePanel();
    rebuildMetricChips();
    rebuildTemplateCards();
    resetAll();
    if (res.warnings.length) {
      fitnessStatus.textContent = `⚠ ${res.warnings.join(" ")}`;
      fitnessStatus.setAttribute("data-ok", "true");
    }
  }

  // config sliders (kept as references so import can sync them)
  const popSlider = slider({
    label: "Population size",
    min: 10,
    max: 150,
    step: 5,
    value: config.populationSize,
    format: (v) => String(v),
    onInput: (v) => {
      config.populationSize = v;
      resetAll();
    },
  });
  const mutRateSlider = slider({
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
  });
  const mutStrSlider = slider({
    label: "Mutation strength",
    min: 0.2,
    max: 2.5,
    step: 0.1,
    value: config.mutationStrength,
    format: (v) => `${v.toFixed(1)}×`,
    onInput: (v) => {
      config.mutationStrength = v;
    },
  });
  const eliteSlider = slider({
    label: "Elite count",
    min: 0,
    max: 12,
    step: 1,
    value: config.eliteCount,
    format: (v) => String(v),
    onInput: (v) => {
      config.eliteCount = v;
    },
  });
  const tournSlider = slider({
    label: "Tournament size",
    min: 2,
    max: 8,
    step: 1,
    value: config.tournamentSize,
    format: (v) => String(v),
    onInput: (v) => {
      config.tournamentSize = v;
    },
  });
  const evalSlider = slider({
    label: "Evaluation time",
    min: 6,
    max: 20,
    step: 1,
    value: config.evaluationSeconds,
    format: (v) => `${v}s`,
    onInput: (v) => {
      config.evaluationSeconds = v;
    },
  });
  const speedSlider = slider({
    label: "Sim speed",
    min: 1,
    max: 6,
    step: 1,
    value: state.replaySpeed,
    format: (v) => `${v}×`,
    onInput: (v) => {
      state.replaySpeed = v;
    },
  });
  function syncConfigSliders() {
    popSlider.input.value = String(config.populationSize);
    popSlider.valueEl.textContent = String(config.populationSize);
    mutRateSlider.input.value = String(config.mutationRate);
    mutRateSlider.valueEl.textContent = `${Math.round(config.mutationRate * 100)}%`;
    mutStrSlider.input.value = String(config.mutationStrength);
    mutStrSlider.valueEl.textContent = `${config.mutationStrength.toFixed(1)}×`;
    eliteSlider.input.value = String(config.eliteCount);
    eliteSlider.valueEl.textContent = String(config.eliteCount);
    tournSlider.input.value = String(config.tournamentSize);
    tournSlider.valueEl.textContent = String(config.tournamentSize);
    evalSlider.input.value = String(config.evaluationSeconds);
    evalSlider.valueEl.textContent = `${config.evaluationSeconds}s`;
  }

  // ---------------------------------------------------------------- tabs
  const controlsTab = el(
    "div",
    { class: "side-controls" },
    el(
      "div",
      { class: "ec-status-row" },
      el("span", { class: "ec-controls-title" }, "Status"),
      statusBadge,
    ),
    el("div", { class: "ec-controls-title" }, "Body template"),
    templateCardWrap,
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
    el("div", { class: "ec-buttons" }, exportBtn, importBtn),
    fileInput,
    fieldLabel("Terrain", terrainSelect),
    popSlider.field,
    mutRateSlider.field,
    mutStrSlider.field,
    eliteSlider.field,
    tournSlider.field,
    evalSlider.field,
    speedSlider.field,
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

  const fitnessTab = el(
    "div",
    { class: "side-controls" },
    el("div", { class: "ec-controls-title" }, "Fitness function"),
    el(
      "p",
      { class: "ec-note" },
      'Define what "better" means. Evolution optimizes exactly this — not what you meant.',
    ),
    fieldLabel("Preset", presetSelect),
    presetNote,
    formulaInput,
    fitnessStatus,
    el("div", { class: "ec-controls-title" }, "Metrics"),
    el(
      "p",
      { class: "ec-note" },
      "Click to insert. Dimmed metrics are always 0 for this body.",
    ),
    metricChipWrap,
    el("div", { class: "ec-controls-title" }, "Why the champion won"),
    breakdownWrap,
  );

  const genesTab = el("div", { class: "side-controls" }, genePanel);

  const statsTab = el(
    "div",
    { class: "ec-stats" },
    genStat.row,
    liveDistStat.row,
    bestFitStat.row,
    avgFitStat.row,
    bestDistStat.row,
    avgDistStat.row,
    templateStat.row,
    terrainStat.row,
  );

  const notesTab = el(
    "section",
    { class: "ec-explanation" },
    el("h3", {}, "What's happening?"),
    el(
      "p",
      {},
      "You define three things: a ",
      el("strong", {}, "body"),
      " (the template), the ",
      el("strong", {}, "search space"),
      " (each gene's editable range), and a ",
      el("strong", {}, "fitness function"),
      " (what scores well). Evolution does the rest.",
    ),
    el(
      "p",
      {},
      "The whole population is dropped onto the same ground and scored by your formula. The best breed; ",
      el("strong", {}, "crossover"),
      " mixes gene groups and ",
      el("strong", {}, "mutation"),
      " nudges values within the ranges you set. Over generations, designs drift toward whatever your fitness rewards.",
    ),
    el(
      "p",
      { class: "ec-tip" },
      "Be careful what you optimize for. Reward distance only, and something may spin or drag its way forward instead of moving cleanly. That's not a bug — it's the lesson.",
    ),
  );

  const panel = createTabPanel(
    [
      { id: "controls", label: "Controls", content: controlsTab },
      { id: "genes", label: "Genes", content: genesTab },
      { id: "fitness", label: "Fitness", content: fitnessTab },
      { id: "stats", label: "Stats", content: statsTab },
      { id: "notes", label: "Notes", content: notesTab },
    ],
    { ariaLabel: "Evolution Sandbox panel" },
  );

  // ---------------------------------------------------------------- layout
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

  const aside = el(
    "aside",
    { class: "concept-aside" },
    el(
      "div",
      { class: "concept-aside-head" },
      el("a", { href: "#/", class: "concept-back" }, "← All concepts"),
      el("h1", { class: "concept-title" }, "Evolution Sandbox"),
      el(
        "p",
        { class: "concept-sub" },
        "Build a body, define success, and watch evolution exploit your rules.",
      ),
    ),
    panel.el,
  );

  const page = el("div", { class: "concept-shell" }, stage, aside);

  document.body.classList.add("concept-open");
  root.replaceChildren(page);

  // initial paint
  rebuildTemplateCards();
  rebuildGenePanel();
  rebuildMetricChips();
  recompileFitness();
  refreshBreakdown();
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

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
