// The Neural Lander engine. Each generation, the whole population flies one of
// the training terrains live (every rover in its own planck world), while a
// small worker pool scores the same genomes on ALL the training terrains in
// parallel. When the live flight ends and the scores are in, the generation is
// ranked by mean reward, bred, and the next one lines up. The live flight is
// one of the scored episodes, not a dramatization: same code, same inputs,
// same result (checked at runtime, see verifyParity).
//
// Pure modules do the thinking (physics, brain, evolution, fitness); this file
// orchestrates, renders and owns the UI. Lazy-loaded by index.ts so planck
// only ships in this chunk.

import { el } from "../../lib/dom.ts";
import { createTabPanel } from "../../lib/tabs.ts";
import { paramCount } from "./brain.ts";
import { createLineChart, createStackChart } from "./charts.ts";
import {
  DEFAULT_DESIGN_ID,
  DESIGNS,
  findDesign,
  inputLabels,
  outputLabels,
  sensorChannels,
  withSensors,
} from "./designs.ts";
import { episodePool } from "./episodes.ts";
import type { EvalContext } from "./evaluate.ts";
import type { EvalRequest, EvalResponse } from "./eval.worker.ts";
import { createInitialPopulation, createNextGeneration, pickBest } from "./evolution.ts";
import { DEFAULT_REWARD, fitnessOf, isCrash, rewardTerms } from "./fitness.ts";
import { createNetView } from "./netview.ts";
import { channelCount, createLanderSim, type LanderSim } from "./physics.ts";
import { DEFAULT_PLANET_ID, PLANETS, findPlanet } from "./planets.ts";
import { hashSeed, mulberry32, type Rng } from "./rng.ts";
import { buildGround, type Ground } from "./terrain.ts";
import type {
  Activation,
  BrainLayout,
  Episode,
  EpisodeResult,
  EvolutionConfig,
  Genome,
  GenomeResult,
  Outcome,
  PlanetConfig,
  RewardWeights,
  RoverDesign,
  Vec,
} from "./types.ts";
import { createLanderView, type RoverRole } from "./view.ts";

const SPEEDS = [1, 2, 4, 8, 16];
const UNSEEN_EPISODES = 20;
const MAX_HISTORY = 1000;
const TRAIL_EVERY = 3; // sim steps between trail points
const TRAIL_MAX = 500;
const COMPARE_GENS = [1, 5, 10, 25, 50, 100, 200, 400];

// Outcome bands for the stacked chart and distribution bars.
const BANDS = [
  { key: "landed", label: "landed" },
  { key: "missed", label: "missed pad" },
  { key: "timeout", label: "hovered" },
  { key: "crash", label: "crashed" },
  { key: "oob", label: "flew off" },
] as const;

const OUTCOME_TEXT: Record<Outcome, string> = {
  landed: "landed on the pad",
  "missed-zone": "landed off the pad",
  timeout: "hovered until timeout",
  "out-of-bounds": "left the arena",
  "hard-impact": "hard impact",
  "excessive-horizontal-speed": "too fast sideways",
  "excessive-tilt": "came down tilted",
  "tip-over": "tipped over",
  "out-of-fuel": "ran out of fuel",
};

// Same glyph vocabulary as the markers in the world view.
const STATUS_GLYPH: Record<Outcome, string> = {
  landed: "✓",
  "missed-zone": "◇",
  timeout: "○",
  "out-of-bounds": "↗",
  "hard-impact": "×",
  "excessive-horizontal-speed": "×",
  "excessive-tilt": "×",
  "tip-over": "×",
  "out-of-fuel": "×",
};

const REWARD_PRESETS: { id: string; label: string; weights: RewardWeights }[] = [
  { id: "default", label: "Balanced", weights: { ...DEFAULT_REWARD } },
  // Survival pays more than landing: the population learns to hover.
  { id: "hover", label: "Hover-happy", weights: { ...DEFAULT_REWARD, alive: 15 } },
  // Fuel left is worth more than anything: don't burn, just fall.
  { id: "miser", label: "Miser", weights: { ...DEFAULT_REWARD, fuel: 4, crash: 0 } },
  // Only distance matters: dive at the pad, impact be damned.
  {
    id: "reckless",
    label: "Reckless",
    weights: { ...DEFAULT_REWARD, landing: 0, touchdown: 0, distance: 12, impact: 0, crash: 0, tilt: 0 },
  },
];

const REWARD_FIELDS: {
  key: keyof RewardWeights;
  label: string;
  max: number;
  step: number;
  unit: string;
}[] = [
  { key: "landing", label: "Landing on the pad", max: 400, step: 10, unit: "" },
  { key: "touchdown", label: "Safe touchdown (anywhere)", max: 200, step: 5, unit: "" },
  { key: "alive", label: "Per second alive", max: 20, step: 0.5, unit: "/s" },
  { key: "fuel", label: "Per % fuel left", max: 5, step: 0.1, unit: "/%" },
  { key: "distance", label: "Distance from pad", max: 15, step: 0.5, unit: "/m" },
  { key: "impact", label: "Speed at the end", max: 20, step: 0.5, unit: "/(m/s)" },
  { key: "tilt", label: "Tilt at the end", max: 20, step: 0.5, unit: "/10°" },
  { key: "crash", label: "Crash", max: 200, step: 5, unit: "" },
  { key: "outOfBounds", label: "Leaving the arena", max: 300, step: 10, unit: "" },
];
const PENALTIES = new Set<keyof RewardWeights>(["distance", "impact", "tilt", "crash", "outOfBounds"]);

type Mode = "idle" | "race" | "scoring" | "show";
type ShowKind = "replay" | "unseen" | "compare";

type Rover = {
  genome: Genome;
  sim: LanderSim;
  trail: Vec[];
  role: RoverRole;
  label?: string;
};

type HistoryPoint = {
  generation: number;
  best: number;
  mean: number;
  median: number;
  landRate: number; // fraction of all (rover × terrain) episodes that landed
  champTrain: number; // champion's landed fraction on the training terrains
  unseen: number; // champion's landed fraction on unseen terrain (NaN until known)
  bands: number[]; // outcome fractions, aligned to BANDS
  topFailure: Outcome | null;
};

type StatusSlug =
  | "idle"
  | "chaos"
  | "crashing"
  | "hovering"
  | "missing"
  | "landing"
  | "reliable"
  | "overfit"
  | "stuck"
  | "high-mutation";

function bandOf(o: Outcome): number {
  if (o === "landed") return 0;
  if (o === "missed-zone") return 1;
  if (o === "timeout") return 2;
  if (o === "out-of-bounds") return 4;
  return 3;
}

export function mount(root: HTMLElement): () => void {
  // --------------------------------------------------------------- config
  const config: EvolutionConfig = {
    populationSize: 64,
    eliteCount: 2,
    mutationRate: 0.1,
    mutationSigma: 0.3,
    crossoverRate: 0.2,
    tournamentSize: 3,
    trainEpisodes: 4,
    maxSeconds: 20,
  };
  let reward: RewardWeights = { ...DEFAULT_REWARD };
  let baseDesign: RoverDesign = findDesign(DEFAULT_DESIGN_ID);
  let enabled = new Set(baseDesign.sensors.map((s) => s.id));
  let hiddenCount = 8;
  let activation: Activation = "tanh";
  let planet: PlanetConfig = findPlanet(DEFAULT_PLANET_ID);
  let evalPlanetId = "same";
  let trainSeed = 6;
  let evalSeed = 2;

  // derived from the config above (rebuilt on reset)
  let design: RoverDesign = baseDesign;
  let layout: BrainLayout = { inputs: 1, hidden: 1, outputs: 1, activation };
  let trainEps: Episode[] = [];
  let evalEps: Episode[] = [];
  let inLabels: string[] = [];
  let outLabels: string[] = [];
  let gaRng: Rng = mulberry32(1);
  let nextIdCounter = 0;
  const nextId = () => ++nextIdCounter;

  const evalPlanet = () => (evalPlanetId === "same" ? planet : findPlanet(evalPlanetId));

  function rebuildDerived() {
    design = withSensors(baseDesign, enabled);
    layout = {
      inputs: channelCount(design),
      hidden: hiddenCount,
      outputs: design.thrusters.length,
      activation,
    };
    inLabels = inputLabels(design);
    outLabels = outputLabels(design);
    trainEps = episodePool(trainSeed, config.trainEpisodes, planet);
    rebuildEvalEpisodes();
    gaRng = mulberry32(hashSeed(trainSeed, 0xa11ce));
  }
  function rebuildEvalEpisodes() {
    // XOR keeps the evaluation stream distinct even if both seeds are equal.
    evalEps = episodePool(evalSeed ^ 0x5eed5, UNSEEN_EPISODES, evalPlanet());
  }

  const trainCtx = (): EvalContext => ({
    design,
    layout,
    planet,
    episodes: trainEps,
    maxSeconds: config.maxSeconds,
  });
  const unseenCtx = (): EvalContext => ({
    design,
    layout,
    planet: evalPlanet(),
    episodes: evalEps,
    maxSeconds: config.maxSeconds,
  });

  // --------------------------------------------------------------- state
  const state = {
    generation: 0, // generations scored so far
    population: [] as Genome[],
    cached: [] as (GenomeResult | null)[],
    results: null as GenomeResult[] | null,
    champion: null as GenomeResult | null, // best of the last scored generation
    bestEver: null as { result: GenomeResult; generation: number } | null,
    championByGen: new Map<number, Genome>(),
    unseenById: new Map<number, number>(),
    archive: new Map<number, { generation: number; parentIds: number[]; fitness: number; landed: number }>(),
    history: [] as HistoryPoint[],
    milestones: [] as { label: string; generation: number }[],
    lastImproveGen: 0,
    mode: "idle" as Mode,
    show: null as ShowKind | null,
    showNote: "",
    evolving: false,
    stepOnce: false,
    paused: false,
    fastForwarding: false,
    speedIndex: 2,
    focus: 0,
    showTrails: true,
    showRays: true,
    showVelocity: false,
    unseenCursor: 0,
    statusSlug: "idle" as StatusSlug,
    statusText: "Idle",
  };

  let rovers: Rover[] = [];
  let raceEpisode = 0;
  let raceGround: Ground | null = null;
  let stepCount = 0;
  let pendingTrain: Promise<EpisodeResult[][]> | null = null;
  let runToken = 0; // bumps on reset; stale async work checks it and bails
  let parityWarned = false;
  let raf = 0;

  const view = createLanderView();
  const netView = createNetView();

  // --------------------------------------------------------------- workers
  // A small pool: each population is split into contiguous chunks, one per
  // worker, and stitched back in order.
  const poolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const workers = Array.from(
    { length: poolSize },
    () => new Worker(new URL("./eval.worker.ts", import.meta.url), { type: "module" }),
  );
  const pending = new Map<number, { resolve: (r: EpisodeResult[][]) => void; reject: (e: Error) => void }>();
  let reqSeq = 0;
  for (const w of workers) {
    w.onmessage = (e: MessageEvent<EvalResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.episodes);
      else p.reject(new Error(e.data.error));
    };
  }
  function evalOn(worker: Worker, ctx: EvalContext, genomes: Genome[]): Promise<EpisodeResult[][]> {
    return new Promise((resolve, reject) => {
      const id = ++reqSeq;
      pending.set(id, { resolve, reject });
      const req: EvalRequest = { id, ctx, genomes };
      worker.postMessage(req);
    });
  }
  async function evaluate(ctx: EvalContext, genomes: Genome[]): Promise<EpisodeResult[][]> {
    if (genomes.length === 0) return [];
    const chunk = Math.ceil(genomes.length / workers.length);
    const parts = await Promise.all(
      workers
        .map((w, i) => ({ w, g: genomes.slice(i * chunk, (i + 1) * chunk) }))
        .filter((p) => p.g.length > 0)
        .map((p) => evalOn(p.w, ctx, p.g)),
    );
    return parts.flat();
  }

  // --------------------------------------------------------------- lineup
  function roleOf(i: number): RoverRole {
    if (!state.cached[i]) return "crowd";
    return state.champion && state.population[i].id === state.champion.genome.id
      ? "champion"
      : "elite";
  }

  function spawnRovers(entries: { genome: Genome; role: RoverRole; label?: string }[], episode: Episode, p: PlanetConfig) {
    raceGround = buildGround(p, episode);
    view.setGround(raceGround);
    view.setDesign(design);
    stepCount = 0;
    rovers = entries.map((e) => ({
      ...e,
      trail: [],
      sim: createLanderSim({
        design,
        layout,
        params: e.genome.params,
        planet: p,
        episode,
        maxSeconds: config.maxSeconds,
        ground: raceGround!,
      }),
    }));
  }

  // Line up the current population on this generation's display terrain,
  // rotating through the training set so you see all of it over time.
  function buildLineup() {
    raceEpisode = state.generation % trainEps.length;
    spawnRovers(
      state.population.map((genome, i) => ({ genome, role: roleOf(i) })),
      trainEps[raceEpisode],
      planet,
    );
    state.show = null;
    const ci = rovers.findIndex((r) => r.role === "champion");
    setFocus(ci >= 0 ? ci : 0);
  }

  // Score the fresh genomes on every training terrain, in the background,
  // while the live flight plays. Elites reuse their cached episodes.
  function startTrainingEval() {
    const fresh = state.population.filter((_, i) => !state.cached[i]);
    pendingTrain = evaluate(trainCtx(), fresh);
    pendingTrain.catch((err) => console.error("[neural-lander] evaluation failed", err));
  }

  function prepareGeneration() {
    buildLineup();
    startTrainingEval();
  }

  function seed() {
    runToken++;
    rebuildDerived();
    nextIdCounter = 0;
    state.generation = 0;
    state.population = createInitialPopulation(layout, config.populationSize, gaRng, nextId);
    state.cached = state.population.map(() => null);
    state.results = null;
    state.champion = null;
    state.bestEver = null;
    state.championByGen.clear();
    state.unseenById.clear();
    state.archive.clear();
    state.history = [];
    state.milestones = [];
    state.lastImproveGen = 0;
    state.unseenCursor = 0;
    state.mode = "idle";
    state.evolving = false;
    state.stepOnce = false;
    state.paused = false;
    state.fastForwarding = false;
    state.statusSlug = "idle";
    state.statusText = "Idle";
    prepareGeneration();
    refreshBuildInfo();
    refreshAll();
    renderNow();
  }

  // --------------------------------------------------------------- scoring
  async function collectResults(): Promise<GenomeResult[]> {
    const fresh = (await pendingTrain) ?? [];
    let k = 0;
    return state.population.map((genome, i) => {
      const episodes = state.cached[i]?.episodes ?? fresh[k++];
      return {
        genome,
        episodes,
        fitness: fitnessOf(episodes, reward),
        landed: episodes.filter((e) => e.outcome === "landed").length,
      };
    });
  }

  // The live flight must match the worker's result for the same episode
  // exactly. If it ever doesn't, determinism broke somewhere; say so once.
  function verifyParity(results: GenomeResult[]) {
    if (parityWarned) return;
    for (let i = 0; i < rovers.length && i < results.length; i++) {
      if (state.cached[i]) continue;
      const live = rovers[i].sim.result();
      const scored = results[i].episodes[raceEpisode];
      if (!scored) continue;
      if (live.outcome !== scored.outcome || Math.abs(live.time - scored.time) > 1e-9) {
        parityWarned = true;
        console.warn("[neural-lander] live flight diverged from the scored episode", { live, scored });
        return;
      }
    }
  }

  function scoreGeneration(results: GenomeResult[]) {
    state.results = results;
    state.generation += 1;
    const gen = state.generation;
    const best = pickBest(results);
    state.champion = best;
    state.championByGen.set(gen, best.genome);
    for (const r of results)
      state.archive.set(r.genome.id, {
        generation: r.genome.generation,
        parentIds: r.genome.parentIds,
        fitness: r.fitness,
        landed: r.landed,
      });
    const improved = !state.bestEver || best.fitness > state.bestEver.result.fitness;
    if (improved) {
      state.bestEver = { result: best, generation: gen };
      state.lastImproveGen = gen;
    }

    const fits = results.map((r) => r.fitness).sort((a, b) => a - b);
    const all = results.flatMap((r) => r.episodes);
    const bands = BANDS.map(() => 0);
    const failures = new Map<Outcome, number>();
    for (const e of all) {
      bands[bandOf(e.outcome)]++;
      if (e.outcome !== "landed") failures.set(e.outcome, (failures.get(e.outcome) ?? 0) + 1);
    }
    let topFailure: Outcome | null = null;
    for (const [o, n] of failures) if (!topFailure || n > (failures.get(topFailure) ?? 0)) topFailure = o;
    const point: HistoryPoint = {
      generation: gen,
      best: best.fitness,
      mean: fits.reduce((s, f) => s + f, 0) / fits.length,
      median: fits[Math.floor(fits.length / 2)],
      landRate: bands[0] / Math.max(1, all.length),
      champTrain: best.landed / Math.max(1, best.episodes.length),
      unseen: NaN,
      bands: bands.map((b) => b / Math.max(1, all.length)),
      topFailure,
    };
    state.history.push(point);
    if (state.history.length > MAX_HISTORY) state.history.shift();

    const milestone = checkMilestones(point, all);
    measureUnseen(best.genome, point);
    deriveStatus();
    refreshAll();
    view.banner(milestone ?? summaryLine(point));
  }

  function summaryLine(p: HistoryPoint): string {
    const prev = state.history[state.history.length - 2];
    const delta = prev ? Math.round((p.landRate - prev.landRate) * 100) : 0;
    const d = delta > 0 ? ` (+${delta})` : delta < 0 ? ` (${delta})` : "";
    const fail = p.topFailure ? ` · most common failure: ${OUTCOME_TEXT[p.topFailure]}` : "";
    return `GEN ${p.generation} · ${Math.round(p.landRate * 100)}% landed${d}${fail}`;
  }

  function checkMilestones(p: HistoryPoint, all: EpisodeResult[]): string | null {
    const have = (label: string) => state.milestones.some((m) => m.label === label);
    const hits: string[] = [];
    const hit = (label: string, cond: boolean) => {
      if (cond && !have(label)) {
        state.milestones.push({ label, generation: p.generation });
        hits.push(label);
      }
    };
    hit("first safe touchdown", all.some((e) => e.outcome === "landed" || e.outcome === "missed-zone"));
    hit("first landing on the pad", p.landRate > 0);
    hit("champion lands on every training terrain", p.champTrain >= 1);
    hit("25% of all attempts land", p.landRate >= 0.25);
    hit("50% of all attempts land", p.landRate >= 0.5);
    hit("90% of all attempts land", p.landRate >= 0.9);
    return hits.length ? `MILESTONE · ${hits[hits.length - 1]} (gen ${p.generation})` : null;
  }

  // Fly the generation's champion on terrain it never trained on. Runs in the
  // background; the chart fills in when it lands (so to speak).
  function measureUnseen(genome: Genome, point: HistoryPoint) {
    const token = runToken;
    evaluate(unseenCtx(), [genome])
      .then(([eps]) => {
        if (token !== runToken || !eps) return;
        const rate = eps.filter((e) => e.outcome === "landed").length / eps.length;
        state.unseenById.set(genome.id, rate);
        point.unseen = rate;
        deriveStatus();
        refreshAll();
      })
      .catch((err) => console.error("[neural-lander] unseen evaluation failed", err));
  }

  function breedNext() {
    const next = createNextGeneration({
      results: state.results!,
      config,
      generation: state.generation + 1,
      rng: gaRng,
      nextId,
    });
    state.population = next.population;
    state.cached = next.cached;
    state.results = null;
  }

  function rescore() {
    if (state.results)
      for (const r of state.results) r.fitness = fitnessOf(r.episodes, reward);
    if (state.results) state.champion = pickBest(state.results);
    for (const c of state.cached) if (c) c.fitness = fitnessOf(c.episodes, reward);
    refreshReward();
  }

  // --------------------------------------------------------------- run loop
  async function finishRace() {
    state.mode = "scoring";
    syncButtons();
    const token = runToken;
    let results: GenomeResult[];
    try {
      results = await collectResults();
    } catch {
      if (token !== runToken) return;
      state.mode = "idle";
      state.evolving = false;
      setStatus("stuck", "Evaluation failed");
      syncButtons();
      return;
    }
    if (token !== runToken) return;
    verifyParity(results);
    scoreGeneration(results);
    breedNext();
    prepareGeneration();
    const keepGoing = state.evolving && !state.stepOnce;
    state.stepOnce = false;
    state.mode = keepGoing ? "race" : "idle";
    syncButtons();
    renderNow();
  }

  function endShow() {
    state.mode = "idle";
    syncButtons();
  }

  function frame() {
    const flying = state.mode === "race" || state.mode === "show";
    if (flying && !state.paused) {
      const steps = SPEEDS[state.speedIndex];
      for (let s = 0; s < steps; s++) {
        let alive = false;
        for (const r of rovers) {
          if (r.sim.done()) continue;
          r.sim.step();
          alive = true;
        }
        stepCount++;
        if (stepCount % TRAIL_EVERY === 0)
          for (const r of rovers) {
            if (r.sim.done() && r.trail.length > 0) continue;
            const st = r.sim.render();
            r.trail.push({ x: st.x, y: st.y });
            if (r.trail.length > TRAIL_MAX) r.trail.shift();
          }
        if (!alive) break;
      }
      renderNow();
      if (rovers.every((r) => r.sim.done())) {
        if (state.mode === "race") void finishRace();
        else endShow();
      }
    }
    raf = requestAnimationFrame(frame);
  }

  // --------------------------------------------------------------- render
  function renderNow() {
    const focus = rovers[state.focus];
    view.render({
      rovers: rovers.map((r, i) => ({
        state: r.sim.render(),
        role: r.role,
        focused: i === state.focus,
        trail: r.trail,
        label: r.label,
      })),
      hud: hudLines(),
      inspector: focus ? inspectorLines(focus) : null,
      showTrails: state.showTrails,
      showRays: state.showRays,
      showVelocity: state.showVelocity,
    });
    if (focus) netView.update(focus.sim.input, focus.sim.hidden, focus.sim.output);
  }

  function hudLines(): string[] {
    const flying = rovers.filter((r) => !r.sim.done()).length;
    const t = rovers[0]?.sim.time ?? 0;
    const clock = `t = ${t.toFixed(1)} s · ${flying}/${rovers.length} flying`;
    if (state.show === "replay")
      return [`REPLAY · best ever (gen ${state.bestEver?.generation ?? "?"})`, state.showNote, clock];
    if (state.show === "unseen") return [`UNSEEN TERRAIN · ${state.showNote}`, clock];
    if (state.show === "compare") return [`COMPARE · ${state.showNote}`, clock];
    const head = `GEN ${state.generation + 1} · training terrain ${raceEpisode + 1}/${trainEps.length} · ${planet.label}`;
    if (state.mode === "scoring") return [head, "scoring on the other training terrains…"];
    if (state.mode === "idle" && state.generation === 0 && t === 0)
      return [head, `${rovers.length} random brains, press Start`];
    return [head, clock];
  }

  function inspectorLines(r: Rover): string[] {
    const s = r.sim.render();
    const g = r.genome;
    const parents = g.parentIds.length ? `parents ${g.parentIds.map((p) => `#${p}`).join(" ")}` : "random init";
    const alt = raceGround ? s.y - 1.25 - raceGround.padY : 0;
    const tilt = (((s.angle % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const status = s.outcome
      ? `${STATUS_GLYPH[s.outcome]} ${OUTCOME_TEXT[s.outcome]}${
          isCrash(s.outcome) ? ` · ${r.sim.result().endSpeed.toFixed(1)} m/s` : ""
        }`
      : "→ flying";
    return [
      `#${g.id} · gen ${g.generation} · ${parents}`,
      `fuel ${Math.round(s.fuel * 100)}%   alt ${alt.toFixed(1)} m`,
      `vx ${s.vx.toFixed(1)}   vy ${s.vy.toFixed(1)} m/s`,
      `tilt ${((tilt * 180) / Math.PI).toFixed(1)}°   spin ${s.spin.toFixed(2)} rad/s`,
      status,
    ];
  }

  function setFocus(i: number) {
    state.focus = Math.max(0, Math.min(rovers.length - 1, i));
    const r = rovers[state.focus];
    if (r) {
      netView.setNetwork(layout, r.genome.params, inLabels, outLabels);
      netTitle.textContent = `Brain of #${r.genome.id}${r.role === "champion" ? " (champion)" : ""}`;
    } else {
      netView.clear();
    }
  }

  // --------------------------------------------------------------- actions
  const busy = () => state.mode !== "idle" || state.fastForwarding;

  // A finished replay / test stays on screen until you ask for the next thing;
  // this puts the generation back first.
  function restoreLineup() {
    if (state.show) buildLineup();
  }

  function startEvolution() {
    if (state.mode === "race" && state.paused) {
      state.paused = false;
      state.evolving = true;
      syncButtons();
      return;
    }
    if (busy()) return;
    restoreLineup();
    state.evolving = true;
    state.stepOnce = false;
    state.paused = false;
    state.mode = "race";
    syncButtons();
  }
  function pause() {
    if (state.mode !== "race" && state.mode !== "show") return;
    state.paused = true;
    state.evolving = false;
    syncButtons();
  }
  function stepGeneration() {
    if (state.mode === "race" && state.paused) {
      state.paused = false;
      state.stepOnce = true;
      syncButtons();
      return;
    }
    if (busy()) return;
    restoreLineup();
    state.evolving = false;
    state.stepOnce = true;
    state.paused = false;
    state.mode = "race";
    syncButtons();
  }
  function togglePause() {
    if ((state.mode === "race" || state.mode === "show") && !state.paused) pause();
    else if (state.mode === "show" && state.paused) {
      state.paused = false;
      syncButtons();
    } else startEvolution();
  }

  // Evolve n generations headlessly. No rendering in between; the worker pool
  // does the flying, the main thread only breeds and paints stats.
  async function fastForward(n: number) {
    if (busy()) return;
    const token = runToken;
    state.fastForwarding = true;
    state.paused = false;
    syncButtons();
    try {
      for (let i = 0; i < n; i++) {
        const results = await collectResults();
        if (token !== runToken) return;
        scoreGeneration(results);
        breedNext();
        startTrainingEval();
      }
    } catch (err) {
      console.error("[neural-lander] fast-forward failed", err);
    }
    if (token !== runToken) return;
    state.fastForwarding = false;
    buildLineup();
    syncButtons();
    renderNow();
  }

  function startShow(kind: ShowKind, entries: { genome: Genome; role: RoverRole; label?: string }[], episode: Episode, p: PlanetConfig, note: string) {
    if (busy()) return;
    spawnRovers(entries, episode, p);
    state.show = kind;
    state.showNote = note;
    state.mode = "show";
    state.paused = false;
    setFocus(entries.findIndex((e) => e.role === "champion") >= 0 ? entries.findIndex((e) => e.role === "champion") : 0);
    syncButtons();
    renderNow();
  }

  function replayChampion() {
    const be = state.bestEver;
    if (!be) return;
    const ep = trainEps[raceEpisode];
    startShow("replay", [{ genome: be.result.genome, role: "champion" }], ep, planet, `training terrain ${raceEpisode + 1}/${trainEps.length}`);
  }

  function testUnseen() {
    const be = state.bestEver;
    if (!be) return;
    const i = state.unseenCursor % evalEps.length;
    state.unseenCursor++;
    const p = evalPlanet();
    startShow(
      "unseen",
      [{ genome: be.result.genome, role: "champion" }],
      evalEps[i],
      p,
      `${i + 1}/${evalEps.length} · ${p.label} · best ever (gen ${be.generation})`,
    );
  }

  function compareGenerations() {
    if (state.generation === 0) return;
    const gens = COMPARE_GENS.filter((g) => g <= state.generation);
    if (!gens.includes(state.generation)) gens.push(state.generation);
    const entries = gens.map((g, k) => ({
      genome: state.championByGen.get(g)!,
      role: (k === gens.length - 1 ? "champion" : "elite") as RoverRole,
      label: `gen ${g}`,
    }));
    startShow("compare", entries, trainEps[0], planet, `champions of gen ${gens.join(", ")} on training terrain 1`);
  }

  function resetAll() {
    seed();
    syncButtons();
  }

  // --------------------------------------------------------------- status
  function setStatus(slug: StatusSlug, text: string) {
    state.statusSlug = slug;
    state.statusText = text;
  }

  function deriveStatus() {
    const last = state.history[state.history.length - 1];
    if (config.mutationRate >= 0.35 || config.mutationSigma >= 0.9)
      return setStatus("high-mutation", "Too much mutation");
    if (!last) return setStatus("idle", "Idle");
    const unseen = Number.isFinite(last.unseen) ? last.unseen : null;
    // Overfitting is a GAP, not a low score: good on what it trained on,
    // much worse on terrain it has never seen.
    if (last.champTrain >= 0.75 && unseen !== null && last.champTrain - unseen >= 0.4)
      return setStatus("overfit", "Memorizing terrain");
    if (last.landRate >= 0.5) return setStatus("reliable", "Landing reliably");
    if (last.landRate > 0) return setStatus("landing", "First landings");
    if (state.generation <= 2) return setStatus("chaos", "Random chaos");
    if (state.generation - state.lastImproveGen >= 12) return setStatus("stuck", "Stuck");
    const [, missed, hover, crash] = last.bands;
    if (hover >= crash && hover >= missed) return setStatus("hovering", "Learning to hover");
    if (missed >= crash) return setStatus("missing", "Landing off the pad");
    return setStatus("crashing", "Mostly crashing");
  }

  function tip(): string {
    switch (state.statusSlug) {
      case "idle":
        return "Press Start. Generation 1 is pure noise: random weights wired to real thrusters.";
      case "chaos":
        return "Random brains, random burns. Selection only needs a few to crash slightly better than the rest.";
      case "crashing":
        return "Most rovers hit the ground too fast. The gentlest crashes score best, so braking spreads first.";
      case "hovering":
        return "Hovering is safe but never scores the landing bonus. Watch for the first rover to commit to the ground.";
      case "missing":
        return "They can touch down softly but not on the pad yet. Steering sideways is the harder skill: tilt, burn, straighten.";
      case "landing":
        return "Someone found the pad. Its weights are now the population's favourite starting point.";
      case "reliable":
        return "Most attempts land. Check the unseen-terrain line: that's the difference between learning and memorizing.";
      case "overfit":
        return "The champion aces its training terrains but fails on new ones. More training terrains usually fixes this.";
      case "stuck":
        return "No improvement for a while. Raise mutation, change the reward, or try a different rover.";
      case "high-mutation":
        return "Mutation is so strong that good brains get scrambled before they can spread.";
    }
  }

  // --------------------------------------------------------------- UI kit
  const stat = (label: string) => {
    const value = el("span", { class: "ec-stat-value" }, "—");
    const row = el("div", { class: "ec-stat" }, el("span", { class: "ec-stat-label" }, label), value);
    return { row, value };
  };

  function slider(opts: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format: (v: number) => string;
    onInput: (v: number) => void;
    onChange?: (v: number) => void;
  }) {
    const valueEl = el("span", { class: "ec-slider-value" }, opts.format(opts.value));
    const input = el("input", {
      type: "range",
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: String(opts.value),
      class: "ec-slider-input",
      name: opts.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      "aria-label": opts.label,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const v = Number(input.value);
      valueEl.textContent = opts.format(v);
      opts.onInput(v);
    });
    if (opts.onChange) input.addEventListener("change", () => opts.onChange!(Number(input.value)));
    const field = el(
      "label",
      { class: "ec-field" },
      el("span", { class: "ec-field-head" }, el("span", {}, opts.label), valueEl),
      input,
    );
    const set = (v: number) => {
      input.value = String(v);
      valueEl.textContent = opts.format(v);
    };
    return { field, input, set };
  }

  const field = (label: string, control: HTMLElement) =>
    el("label", { class: "ec-field" }, el("span", { class: "ec-field-head" }, label), control);

  const btn = (label: string, onClick: () => void, cls = "ec-btn") =>
    el("button", { type: "button", class: cls, onClick }, label);

  const check = (label: string, checked: boolean, onChange: (v: boolean) => void) => {
    const input = el("input", {
      type: "checkbox",
      class: "ec-check",
      name: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    }) as HTMLInputElement;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    return { row: el("label", { class: "ec-toggle" }, input, el("span", {}, label)), input };
  };

  const select = (label: string, options: { value: string; label: string }[], value: string, onChange: (v: string) => void) => {
    const s = el(
      "select",
      { class: "ec-select", name: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "aria-label": label },
      ...options.map((o) => el("option", { value: o.value }, o.label)),
    ) as HTMLSelectElement;
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };

  // --------------------------------------------------------------- Train tab
  const statusBadge = el("span", { class: "ec-status nl-status", "data-status": "idle" }, "Idle");
  const startBtn = btn("Start evolution", startEvolution, "ec-btn ec-btn--primary");
  const pauseBtn = btn("Pause", pause);
  const stepBtn = btn("Step gen", stepGeneration);
  const ffBtn = btn("Evolve ×10", () => void fastForward(10));
  const resetBtn = btn("Reset", resetAll);
  const replayBtn = btn("Replay champion", replayChampion);
  const unseenBtn = btn("Test on unseen terrain", testUnseen);
  const compareBtn = btn("Compare generations", compareGenerations);

  function syncButtons() {
    const b = busy();
    const running = (state.mode === "race" || state.mode === "show") && !state.paused;
    startBtn.textContent = state.mode === "race" && state.paused ? "Resume evolution" : "Start evolution";
    startBtn.toggleAttribute("disabled", (b && !(state.mode === "race" && state.paused)) || false);
    pauseBtn.toggleAttribute("disabled", !running);
    stepBtn.toggleAttribute("disabled", b && !(state.mode === "race" && state.paused));
    ffBtn.toggleAttribute("disabled", b);
    replayBtn.toggleAttribute("disabled", b || !state.bestEver);
    unseenBtn.toggleAttribute("disabled", b || !state.bestEver);
    compareBtn.toggleAttribute("disabled", b || state.generation === 0);
    ffBtn.textContent = state.fastForwarding ? "Evolving…" : "Evolve ×10";
  }

  const speedSlider = slider({
    label: "Flight speed",
    min: 0,
    max: SPEEDS.length - 1,
    step: 1,
    value: state.speedIndex,
    format: (v) => `${SPEEDS[v]}×`,
    onInput: (v) => {
      state.speedIndex = v;
    },
  });

  const popSlider = slider({
    label: "Population",
    min: 16,
    max: 192,
    step: 16,
    value: config.populationSize,
    format: String,
    onInput: () => {},
    onChange: (v) => {
      config.populationSize = v;
      resetAll();
    },
  });
  const rateSlider = slider({
    label: "Mutation rate",
    min: 0,
    max: 0.5,
    step: 0.01,
    value: config.mutationRate,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      config.mutationRate = v;
      deriveStatus();
      refreshStatus();
    },
  });
  const sigmaSlider = slider({
    label: "Mutation strength (σ)",
    min: 0.02,
    max: 1.2,
    step: 0.02,
    value: config.mutationSigma,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      config.mutationSigma = v;
      deriveStatus();
      refreshStatus();
    },
  });
  const crossSlider = slider({
    label: "Crossover",
    min: 0,
    max: 1,
    step: 0.05,
    value: config.crossoverRate,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      config.crossoverRate = v;
    },
  });
  const eliteSlider = slider({
    label: "Elites kept",
    min: 0,
    max: 10,
    step: 1,
    value: config.eliteCount,
    format: String,
    onInput: (v) => {
      config.eliteCount = v;
    },
  });
  const tourSlider = slider({
    label: "Tournament size",
    min: 2,
    max: 8,
    step: 1,
    value: config.tournamentSize,
    format: String,
    onInput: (v) => {
      config.tournamentSize = v;
    },
  });
  const timeoutSlider = slider({
    label: "Episode timeout",
    min: 10,
    max: 40,
    step: 1,
    value: config.maxSeconds,
    format: (v) => `${v}s`,
    onInput: () => {},
    onChange: (v) => {
      config.maxSeconds = v;
      resetAll();
    },
  });

  const trailsCheck = check("Show every trail", state.showTrails, (v) => {
    state.showTrails = v;
    renderNow();
  });
  const raysCheck = check("Show the focused rover's sensor rays", state.showRays, (v) => {
    state.showRays = v;
    renderNow();
  });
  const velCheck = check("Show velocity vectors", state.showVelocity, (v) => {
    state.showVelocity = v;
    renderNow();
  });

  const trainTab = el(
    "div",
    { class: "side-controls" },
    el("div", { class: "ec-status-row" }, el("span", { class: "ec-controls-title" }, "Status"), statusBadge),
    el("div", { class: "ec-buttons" }, startBtn, pauseBtn, stepBtn, ffBtn, resetBtn),
    el("div", { class: "ec-buttons" }, replayBtn, compareBtn, unseenBtn),
    speedSlider.field,
    popSlider.field,
    rateSlider.field,
    sigmaSlider.field,
    crossSlider.field,
    eliteSlider.field,
    tourSlider.field,
    timeoutSlider.field,
    el("div", { class: "ec-overlays" }, trailsCheck.row, raysCheck.row, velCheck.row),
    el("p", { class: "ec-note" }, "Space pauses and resumes. Click a rover to inspect its brain."),
  );

  // --------------------------------------------------------------- Build tab
  const designBlurb = el("p", { class: "ec-note" });
  const designSelect = select(
    "Rover",
    DESIGNS.map((d) => ({ value: d.id, label: d.label })),
    baseDesign.id,
    (id) => {
      baseDesign = findDesign(id);
      enabled = new Set(baseDesign.sensors.map((s) => s.id));
      rebuildSensorList();
      resetAll();
    },
  );
  const sensorList = el("div", { class: "ec-overlays" });
  const thrusterList = el("div", { class: "ec-stats" });
  const brainInfo = el("p", { class: "ec-note" });

  function rebuildSensorList() {
    designBlurb.textContent = baseDesign.blurb;
    sensorList.replaceChildren(
      ...baseDesign.sensors.map((s) => {
        const n = sensorChannels(s).length;
        return check(`${s.label} · ${n} input${n > 1 ? "s" : ""}`, enabled.has(s.id), (on) => {
          if (on) enabled.add(s.id);
          else enabled.delete(s.id);
          resetAll();
        }).row;
      }),
    );
    thrusterList.replaceChildren(
      ...baseDesign.thrusters.map((t) => stat(t.label)).map((s, i) => {
        const t = baseDesign.thrusters[i];
        s.value.textContent = `${t.maxForce} N`;
        return s.row;
      }),
    );
  }

  function refreshBuildInfo() {
    brainInfo.textContent = `${layout.inputs} inputs → ${layout.hidden} hidden → ${layout.outputs} outputs · ${paramCount(layout)} weights and biases for evolution to tune.`;
    planetBlurb.textContent = planet.blurb;
  }

  const hiddenSlider = slider({
    label: "Hidden neurons",
    min: 1,
    max: 16,
    step: 1,
    value: hiddenCount,
    format: String,
    onInput: () => {},
    onChange: (v) => {
      hiddenCount = v;
      resetAll();
    },
  });
  const activationSelect = select(
    "Hidden activation",
    [
      { value: "tanh", label: "tanh" },
      { value: "relu", label: "ReLU" },
      { value: "sigmoid", label: "sigmoid" },
    ],
    activation,
    (v) => {
      activation = v as Activation;
      resetAll();
    },
  );
  const planetBlurb = el("p", { class: "ec-note" });
  const planetSelect = select(
    "Planet",
    PLANETS.map((p) => ({ value: p.id, label: p.label })),
    planet.id,
    (id) => {
      planet = findPlanet(id);
      resetAll();
    },
  );
  const evalPlanetSelect = select(
    "Evaluate on",
    [{ value: "same", label: "Same planet" }, ...PLANETS.map((p) => ({ value: p.id, label: p.label }))],
    evalPlanetId,
    (id) => {
      evalPlanetId = id;
      rebuildEvalEpisodes();
      state.unseenCursor = 0;
      if (state.champion) measureUnseen(state.champion.genome, state.history[state.history.length - 1]);
    },
  );
  const episodesSlider = slider({
    label: "Training terrains per genome",
    min: 1,
    max: 8,
    step: 1,
    value: config.trainEpisodes,
    format: String,
    onInput: () => {},
    onChange: (v) => {
      config.trainEpisodes = v;
      resetAll();
    },
  });
  const seedInput = (value: number, onSet: (v: number) => void, label: string) => {
    const input = el("input", {
      type: "number",
      class: "ec-select",
      name: label.toLowerCase().replace(/\s+/g, "-"),
      "aria-label": label,
      value: String(value),
      min: "0",
      step: "1",
    }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const v = Math.max(0, Math.floor(Number(input.value) || 0));
      input.value = String(v);
      onSet(v);
    });
    return input;
  };
  const trainSeedInput = seedInput(trainSeed, (v) => {
    trainSeed = v;
    resetAll();
  }, "Training seed");
  const evalSeedInput = seedInput(evalSeed, (v) => {
    evalSeed = v;
    rebuildEvalEpisodes();
    state.unseenCursor = 0;
    if (state.champion) measureUnseen(state.champion.genome, state.history[state.history.length - 1]);
  }, "Evaluation seed");

  const buildTab = el(
    "div",
    { class: "side-controls" },
    field("Rover", designSelect),
    designBlurb,
    el("h4", { class: "ec-inspector-group" }, "Sensors (the only things it can know)"),
    sensorList,
    el("h4", { class: "ec-inspector-group" }, "Thrusters"),
    thrusterList,
    el("h4", { class: "ec-inspector-group" }, "Brain"),
    hiddenSlider.field,
    field("Hidden activation", activationSelect),
    brainInfo,
    el("h4", { class: "ec-inspector-group" }, "World"),
    field("Planet", planetSelect),
    planetBlurb,
    episodesSlider.field,
    field("Evaluate on (unseen terrain)", evalPlanetSelect),
    el("div", { class: "nl-seeds" }, field("Training seed", trainSeedInput), field("Evaluation seed", evalSeedInput)),
    el("p", { class: "ec-note" }, "Changing the rover, brain, planet or seeds starts a fresh population: the network's shape or its world changed."),
  );

  // --------------------------------------------------------------- Reward tab
  const rewardSliders = new Map<keyof RewardWeights, ReturnType<typeof slider>>();
  for (const f of REWARD_FIELDS) {
    rewardSliders.set(
      f.key,
      slider({
        label: f.label,
        min: 0,
        max: f.max,
        step: f.step,
        value: reward[f.key],
        format: (v) => `${PENALTIES.has(f.key) ? "−" : "+"}${v}${f.unit}`,
        onInput: (v) => {
          reward = { ...reward, [f.key]: v };
          rescore();
        },
      }),
    );
  }
  function applyRewardPreset(w: RewardWeights) {
    reward = { ...w };
    for (const [k, s] of rewardSliders) s.set(reward[k]);
    rescore();
  }
  const breakdownWrap = el("div", { class: "es-breakdown" });
  function refreshReward() {
    breakdownWrap.replaceChildren();
    const c = state.champion;
    if (!c) {
      breakdownWrap.append(el("p", { class: "ec-note" }, "No champion yet: evolve a generation first."));
      return;
    }
    const sums = new Map<string, number>();
    for (const e of c.episodes)
      for (const t of rewardTerms(e, reward)) sums.set(t.label, (sums.get(t.label) ?? 0) + t.value / c.episodes.length);
    for (const [label, value] of sums) {
      if (Math.abs(value) < 0.05) continue;
      breakdownWrap.append(
        el(
          "div",
          { class: "es-breakdown-row" },
          el("span", { class: "es-breakdown-label" }, label),
          el("span", { class: value < 0 ? "es-breakdown-minus" : "es-breakdown-plus" }, `${value >= 0 ? "+" : ""}${value.toFixed(1)}`),
        ),
      );
    }
    breakdownWrap.append(
      el("div", { class: "es-breakdown-total" }, el("span", {}, "fitness (mean per terrain)"), el("span", {}, c.fitness.toFixed(1))),
    );
  }
  const rewardTab = el(
    "div",
    { class: "side-controls" },
    el(
      "p",
      { class: "ec-note" },
      "Fitness is the average reward over the training terrains. Change it mid-run: nothing resets, the next round of selection just starts favouring different behaviour.",
    ),
    el(
      "div",
      { class: "es-chips" },
      ...REWARD_PRESETS.map((p) => btn(p.label, () => applyRewardPreset(p.weights), "es-chip")),
    ),
    ...[...rewardSliders.values()].map((s) => s.field),
    el("h4", { class: "ec-inspector-group" }, "Why the champion scored what it did"),
    breakdownWrap,
  );

  // --------------------------------------------------------------- Stats tab
  const genStat = stat("generation");
  const landStat = stat("landing rate");
  const bestStat = stat("best fitness");
  const meanStat = stat("average fitness");
  const medianStat = stat("median fitness");
  const failStat = stat("most common failure");
  const champTrainStat = stat("champion, training terrain");
  const champUnseenStat = stat("champion, unseen terrain");
  const elitesStat = stat("elites carried over");
  const distWrap = el("div", { class: "nl-dist" });
  const fitChart = createLineChart({
    ariaLabel: "Best, average and median fitness per generation",
    classes: ["ec-graph-best", "ec-graph-avg", "nl-graph-median"],
  });
  const lineageWrap = el("div", { class: "ec-stats" });
  const milestoneWrap = el("div", { class: "ec-stats" });

  function refreshStats() {
    const last = state.history[state.history.length - 1];
    genStat.value.textContent = String(state.generation);
    landStat.value.textContent = last ? `${(last.landRate * 100).toFixed(1)}%` : "—";
    bestStat.value.textContent = last ? last.best.toFixed(1) : "—";
    meanStat.value.textContent = last ? last.mean.toFixed(1) : "—";
    medianStat.value.textContent = last ? last.median.toFixed(1) : "—";
    failStat.value.textContent = last?.topFailure ? OUTCOME_TEXT[last.topFailure] : "—";
    champTrainStat.value.textContent = state.champion
      ? `${state.champion.landed}/${state.champion.episodes.length} landed`
      : "—";
    const u = state.champion ? state.unseenById.get(state.champion.genome.id) : undefined;
    champUnseenStat.value.textContent = u === undefined ? "—" : `${Math.round(u * 100)}% of ${evalEps.length}`;
    const elites = state.cached
      .map((c, i) => (c ? `#${state.population[i].id}` : null))
      .filter(Boolean);
    elitesStat.value.textContent = elites.length ? elites.join(" ") : "none";

    distWrap.replaceChildren(
      ...BANDS.map((b, i) => {
        const f = last ? last.bands[i] : 0;
        return el(
          "div",
          { class: "nl-dist-row" },
          el("span", { class: "nl-dist-label" }, b.label),
          el("span", { class: "nl-dist-track" }, el("span", { class: `nl-dist-bar nl-band--${b.key}`, style: { width: `${(f * 100).toFixed(1)}%` } })),
          el("span", { class: "nl-dist-value" }, `${Math.round(f * 100)}%`),
        );
      }),
    );

    fitChart.draw([
      state.history.map((h) => h.best),
      state.history.map((h) => h.mean),
      state.history.map((h) => h.median),
    ]);

    // Ancestry: follow the first parent back through the archive (design §30).
    lineageWrap.replaceChildren();
    if (state.champion) {
      let id: number | undefined = state.champion.genome.id;
      for (let n = 0; n < 10 && id !== undefined; n++) {
        const a = state.archive.get(id);
        if (!a) break;
        const s = stat(`gen ${a.generation} · #${id}`);
        s.value.textContent = `fitness ${a.fitness.toFixed(0)} · ${a.landed}/${trainEps.length} landed`;
        lineageWrap.append(s.row);
        id = a.parentIds[0];
      }
    } else lineageWrap.append(el("p", { class: "ec-note" }, "No champion yet."));

    milestoneWrap.replaceChildren(
      ...(state.milestones.length
        ? state.milestones.map((m) => {
            const s = stat(m.label);
            s.value.textContent = `gen ${m.generation}`;
            return s.row;
          })
        : [el("p", { class: "ec-note" }, "None yet.")]),
    );
  }

  const statsTab = el(
    "div",
    { class: "side-controls" },
    el("h4", { class: "ec-inspector-group" }, "Last generation"),
    el(
      "div",
      { class: "ec-stats" },
      genStat.row,
      landStat.row,
      bestStat.row,
      meanStat.row,
      medianStat.row,
      failStat.row,
      champTrainStat.row,
      champUnseenStat.row,
      elitesStat.row,
    ),
    el("h4", { class: "ec-inspector-group" }, "How its episodes ended"),
    distWrap,
    el(
      "div",
      { class: "ec-graph-head" },
      el("span", {}, "Fitness"),
      el(
        "span",
        { class: "ec-graph-legend" },
        el("span", { class: "ec-legend ec-legend--best" }, "best"),
        el("span", { class: "ec-legend ec-legend--avg" }, "average"),
        el("span", { class: "ec-legend nl-legend--median" }, "median"),
      ),
    ),
    fitChart.el,
    el("h4", { class: "ec-inspector-group" }, "Champion's ancestry"),
    lineageWrap,
    el("h4", { class: "ec-inspector-group" }, "Milestones"),
    milestoneWrap,
  );

  // --------------------------------------------------------------- Notes tab
  const tipEl = el("p", { class: "ec-tip" });
  type Challenge = { title: string; text: string; apply: () => void };
  const CHALLENGES: Challenge[] = [
    {
      title: "Can it land blind?",
      text: "Switch off every range sensor. Velocity and the beacon remain, but it can't see the ground coming.",
      apply: () => {
        baseDesign = findDesign("balanced");
        enabled = new Set(baseDesign.sensors.filter((s) => s.kind !== "range").map((s) => s.id));
      },
    },
    {
      title: "Lose the beacon",
      text: "Without the pad beacon, nothing tells the network where the pad is. It can learn to land, but where?",
      apply: () => {
        baseDesign = findDesign("balanced");
        enabled = new Set(baseDesign.sensors.filter((s) => s.kind !== "beacon").map((s) => s.id));
      },
    },
    {
      title: "Tiny brain",
      text: "Two hidden neurons. Everything the rover does has to squeeze through them.",
      apply: () => {
        hiddenCount = 2;
      },
    },
    {
      title: "Does it generalize?",
      text: "Train on a single terrain, then watch the unseen-terrain line fall behind the training one.",
      apply: () => {
        config.trainEpisodes = 1;
      },
    },
    {
      title: "Bad incentives",
      text: "Pay for every second alive. Hovering forever becomes the best strategy, and evolution finds it.",
      apply: () => applyRewardPreset(REWARD_PRESETS[1].weights),
    },
    {
      title: "Different planet",
      text: "Train on the Moon, evaluate on Mars: twice the gravity, wind, and noise it has never felt.",
      apply: () => {
        planet = findPlanet("moon");
        evalPlanetId = "mars";
      },
    },
    {
      title: "Bad design",
      text: "An off-centre engine and one side thruster. No brain fully compensates for a body that can't be controlled.",
      apply: () => {
        baseDesign = findDesign("bad");
        enabled = new Set(baseDesign.sensors.map((s) => s.id));
      },
    },
    {
      title: "Crank the crossover",
      text: "Mix parents on every child. Hidden neurons can sit in any order, so blending two brains often breaks both.",
      apply: () => {
        config.crossoverRate = 0.9;
      },
    },
  ];
  function runChallenge(c: Challenge) {
    // Challenges start from defaults so they don't stack on each other.
    config.trainEpisodes = 4;
    config.crossoverRate = 0.2;
    hiddenCount = 8;
    activation = "tanh";
    planet = findPlanet(DEFAULT_PLANET_ID);
    evalPlanetId = "same";
    baseDesign = findDesign(DEFAULT_DESIGN_ID);
    enabled = new Set(baseDesign.sensors.map((s) => s.id));
    applyRewardPreset(DEFAULT_REWARD);
    c.apply();
    syncControls();
    resetAll();
    panel.select("train");
  }
  function syncControls() {
    designSelect.value = baseDesign.id;
    rebuildSensorList();
    hiddenSlider.set(hiddenCount);
    activationSelect.value = activation;
    planetSelect.value = planet.id;
    evalPlanetSelect.value = evalPlanetId;
    episodesSlider.set(config.trainEpisodes);
    crossSlider.set(config.crossoverRate);
  }

  const notesTab = el(
    "section",
    { class: "ec-explanation" },
    el("h3", {}, "What's happening?"),
    el(
      "p",
      {},
      "Each rover is flown by a tiny ",
      el("strong", {}, "neural network"),
      ". Every 60th of a second its ",
      el("strong", {}, "sensors"),
      " are read, normalized and fed in; the outputs set each ",
      el("strong", {}, "thruster's"),
      " throttle; physics moves the rover; repeat. The network only knows what its sensors expose.",
    ),
    el(
      "p",
      {},
      "Nobody trains the weights by hand. Generation 1 is random. Each rover is scored by the ",
      el("strong", {}, "reward"),
      " averaged over several training terrains; the best become ",
      el("strong", {}, "parents"),
      ", their weights are copied with small random ",
      el("strong", {}, "mutations"),
      ", and the next generation flies. Evolution keeps the slightly better mistakes.",
    ),
    el(
      "p",
      {},
      "The flight you watch is one of the training terrains, not a dramatization. The ",
      el("strong", {}, "unseen terrain"),
      " line tests the champion somewhere it never trained: that gap is overfitting.",
    ),
    tipEl,
    el("h3", { class: "nl-challenges-head" }, "Try this"),
    el(
      "div",
      { class: "nl-challenges" },
      ...CHALLENGES.map((c) =>
        el(
          "div",
          { class: "nl-challenge" },
          el("div", { class: "nl-challenge-title" }, c.title),
          el("p", { class: "nl-challenge-text" }, c.text),
          btn("Try it", () => runChallenge(c), "ec-btn nl-challenge-btn"),
        ),
      ),
    ),
  );

  // --------------------------------------------------------------- stage
  const netTitle = el("span", {}, "Brain");
  const landChart = createLineChart({
    ariaLabel: "Landing rate per generation: whole population on training terrain, and the champion on unseen terrain",
    classes: ["nl-graph-land", "nl-graph-unseen"],
  });
  const stackChart = createStackChart({
    ariaLabel: "How episodes ended, per generation",
    classes: BANDS.map((b) => `nl-band nl-band--${b.key}`),
  });

  const foot = el(
    "div",
    { class: "nl-foot" },
    el(
      "div",
      { class: "nl-foot-net" },
      el("div", { class: "ec-graph-head" }, netTitle, el("span", {}, "sensors → hidden → thrusters")),
      netView.el,
    ),
    el(
      "div",
      { class: "nl-foot-charts" },
      el(
        "div",
        { class: "ec-graph-head" },
        el("span", {}, "Landing rate"),
        el(
          "span",
          { class: "ec-graph-legend" },
          el("span", { class: "ec-legend nl-legend--land" }, "population"),
          el("span", { class: "ec-legend nl-legend--unseen" }, "champion, unseen"),
        ),
      ),
      landChart.el,
      el(
        "div",
        { class: "ec-graph-head" },
        el("span", {}, "How episodes ended"),
        el(
          "span",
          { class: "ec-graph-legend nl-band-legend" },
          ...BANDS.map((b) => el("span", { class: `ec-legend nl-legend-band nl-band--${b.key}` }, b.label)),
        ),
      ),
      stackChart.el,
    ),
  );

  function drawFootCharts() {
    landChart.draw(
      [state.history.map((h) => h.landRate * 100), state.history.map((h) => h.unseen * 100)],
      { min: 0, max: 100 },
    );
    stackChart.draw(state.history.map((h) => h.bands));
  }

  function refreshStatus() {
    statusBadge.textContent = state.statusText;
    statusBadge.setAttribute("data-status", state.statusSlug);
    tipEl.textContent = tip();
  }

  function refreshAll() {
    refreshStatus();
    refreshStats();
    refreshReward();
    drawFootCharts();
    syncButtons();
  }

  const stage = el(
    "div",
    { class: "concept-stage" },
    el("div", { class: "concept-stage-main" }, view.el),
    el("div", { class: "concept-stage-foot" }, foot),
  );

  const panel = createTabPanel(
    [
      { id: "train", label: "Train", content: trainTab },
      { id: "build", label: "Build", content: buildTab },
      { id: "reward", label: "Reward", content: rewardTab },
      { id: "stats", label: "Stats", content: statsTab },
      { id: "notes", label: "Notes", content: notesTab },
    ],
    { ariaLabel: "Neural Lander panel" },
  );

  const aside = el(
    "aside",
    { class: "concept-aside" },
    el(
      "div",
      { class: "concept-aside-head" },
      el("a", { href: "#/", class: "concept-back" }, "← All concepts"),
      el("h1", { class: "concept-title" }, "Neural Lander"),
      el(
        "p",
        { class: "concept-sub" },
        "Wire up a rover's senses, then watch a population of tiny neural networks evolve from making craters to making touchdowns.",
      ),
    ),
    panel.el,
  );

  const page = el("div", { class: "concept-shell nl-shell" }, stage, aside);

  view.onPick((i) => {
    setFocus(i);
    renderNow();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.code !== "Space") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON")) return;
    e.preventDefault();
    togglePause();
  };
  window.addEventListener("keydown", onKey);

  document.body.classList.add("concept-open");
  root.replaceChildren(page);
  rebuildSensorList();
  seed();
  syncButtons();
  raf = requestAnimationFrame(frame);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    runToken++;
    window.removeEventListener("keydown", onKey);
    for (const w of workers) w.terminate();
    pending.clear();
    view.dispose();
    document.body.classList.remove("concept-open");
  };
}
