// Shared Planck (Box2D) scaffolding: fixed timestep, the ground, the collision
// group that lets a whole crowd share one world without touching each other, and
// the generic metrics tracker. The tracker math is copied verbatim from the
// Evolution Sandbox — it derives body-agnostic metrics (distance, spin, jumps,
// flips, stability, instability, airtime) from the root body's pose each step, so
// it means the same thing for a two-legged crawler or a six-legged sprawler.
//
// Unlike the sandbox, the sim runners here take a BUILDER CALLBACK rather than a
// Template. The interpreter turns a BodyGraph into a PhenotypeInstance; physics
// only needs "give me a phenotype in this world". That keeps physics ← interpreter
// as a one-way dependency (no cycle).

import { Edge, Vec2, World } from "planck";
import { emptyMetrics, type FitnessMetrics } from "./metrics.ts";
import { sampleTerrain } from "./terrain.ts";
import type { PhenotypeInstance, PhenotypeRenderState, Terrain } from "./types.ts";

export const FIXED_DT = 1 / 60;
export const VEL_ITERS = 8;
export const POS_ITERS = 3;
export const GRAVITY_Y = -10;

// Every part, across the whole population, shares this negative filter group, so
// nothing collides with anything except the ground.
export const MORPH_GROUP = -1;

const SPIN_ANGVEL = 7;
const INSTAB_LINVEL = 34;
const INSTAB_ANGVEL = 22;
const INSTAB_ABORT = 3.0;
const STUCK_GRACE = 1.2;
const STUCK_ABORT = 3.0;
const TWO_PI = Math.PI * 2;

const GROUND_START = -6;
const GROUND_END = 440;
const GROUND_STEP = 1;

export function buildGround(world: World, terrain: Terrain): void {
  const ground = world.createBody({ type: "static" });
  const pts = sampleTerrain(terrain, GROUND_START, GROUND_END, GROUND_STEP);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    ground.createFixture({
      shape: new Edge(new Vec2(a.x, a.y), new Vec2(b.x, b.y)),
      friction: 0.9,
    });
  }
}

export type MotionSample = {
  x: number;
  y: number;
  angle: number; // unbounded (Box2D accumulates it — good for flip counting)
  vx: number;
  vy: number;
  angVel: number;
  anyOnGround: boolean;
};

export type MetricsTracker = {
  metrics: FitnessMetrics;
  step(sample: MotionSample): void;
  addEnergy(joules: number): void;
  addContact(kind: "body" | "wheel" | "limb", seconds: number): void;
  aborted(): boolean;
};

export function createMetricsTracker(
  spawnX: number,
  spawnY: number,
): MetricsTracker {
  const metrics = emptyMetrics();
  let initialAngle = NaN;
  let steps = 0;
  let velSum = 0;
  let sinceProgress = 0;
  let stuckRun = 0;
  let exploded = false;
  let minY = spawnY;

  return {
    metrics,
    step(s) {
      if (Number.isNaN(initialAngle)) initialAngle = s.angle;
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || s.y < -30)
        exploded = true;

      steps++;
      metrics.survivalTime += FIXED_DT;

      const x = s.x - spawnX;
      metrics.finalX = x;
      if (x > metrics.maxX + 0.02) {
        metrics.maxX = x;
        sinceProgress = 0;
        stuckRun = 0;
      } else {
        sinceProgress += FIXED_DT;
        if (sinceProgress > STUCK_GRACE) stuckRun += FIXED_DT;
      }
      metrics.distance = metrics.maxX;

      velSum += s.vx;
      metrics.averageSpeed = velSum / steps;

      metrics.stability += Math.max(0, Math.cos(s.angle)) * FIXED_DT;

      if (Math.abs(s.angVel) > SPIN_ANGVEL) metrics.spinTime += FIXED_DT;

      const rotations = Math.abs(s.angle - initialAngle) / TWO_PI;
      metrics.flipCount = Math.floor(rotations);

      if (s.y < minY) minY = s.y;
      const rise = s.y - minY;
      if (rise > metrics.jumpHeight) metrics.jumpHeight = rise;
      if (!s.anyOnGround) metrics.airtime += FIXED_DT;

      if (
        Math.abs(s.vx) > INSTAB_LINVEL ||
        Math.abs(s.vy) > INSTAB_LINVEL ||
        Math.abs(s.angVel) > INSTAB_ANGVEL
      ) {
        metrics.instability += FIXED_DT;
      }
    },
    addEnergy(j) {
      metrics.energyUsed += j;
    },
    addContact(kind, seconds) {
      if (kind === "body") metrics.bodyGroundContactTime += seconds;
      else if (kind === "wheel") metrics.wheelGroundContactTime += seconds;
      else metrics.limbGroundContactTime += seconds;
    },
    aborted() {
      return (
        exploded || metrics.instability >= INSTAB_ABORT || stuckRun >= STUCK_ABORT
      );
    },
  };
}

// A builder makes one phenotype in a given world. The interpreter supplies these;
// physics stays ignorant of what a BodyGraph is.
export type PhenotypeBuilder = (world: World) => PhenotypeInstance;

// --- single phenotype (headless eval + champion replay) -------------------
export type MorphSim = {
  step(): void;
  readonly time: number;
  readonly metrics: FitnessMetrics;
  getRenderState(): PhenotypeRenderState;
  bodyX(): number;
  done(): boolean;
};

export function createSingleSim(
  build: PhenotypeBuilder,
  terrain: Terrain,
): MorphSim {
  const world = new World({ gravity: { x: 0, y: GRAVITY_Y } });
  buildGround(world, terrain);
  const inst = build(world);
  let time = 0;
  return {
    step() {
      inst.update(time);
      world.step(FIXED_DT, VEL_ITERS, POS_ITERS);
      time += FIXED_DT;
    },
    get time() {
      return time;
    },
    metrics: inst.metrics,
    getRenderState: () => inst.getRenderState(),
    bodyX: () => inst.bodyX(),
    done: () => inst.done(),
  };
}

// --- whole population in one world (the live race) ------------------------
export type PopulationRenderItem = {
  state: PhenotypeRenderState;
  finished: boolean;
  isLeader: boolean;
};

export type PopulationSim = {
  step(): void;
  readonly time: number;
  allDone(): boolean;
  leaderX(): number;
  bestMaxX(): number;
  renderItems(): PopulationRenderItem[];
  metricsList(): FitnessMetrics[];
  destroy(): void;
};

export function createPopulationSim(
  builds: PhenotypeBuilder[],
  terrain: Terrain,
): PopulationSim {
  const world = new World({ gravity: { x: 0, y: GRAVITY_Y } });
  buildGround(world, terrain);
  const insts: PhenotypeInstance[] = builds.map((b) => b(world));
  let time = 0;

  function leaderIndex(): number {
    let bi = 0;
    for (let i = 1; i < insts.length; i++) {
      if (insts[i].metrics.maxX > insts[bi].metrics.maxX) bi = i;
    }
    return bi;
  }

  return {
    step() {
      for (const inst of insts) if (!inst.finished) inst.update(time);
      world.step(FIXED_DT, VEL_ITERS, POS_ITERS);
      time += FIXED_DT;
      for (const inst of insts) {
        if (inst.finished) continue;
        if (inst.done()) {
          inst.finished = true;
          inst.deactivate();
        }
      }
    },
    get time() {
      return time;
    },
    allDone: () => insts.every((i) => i.finished),
    leaderX() {
      let m = -Infinity;
      for (const i of insts) m = Math.max(m, i.bodyX());
      return m;
    },
    bestMaxX() {
      let m = 0;
      for (const i of insts) m = Math.max(m, i.metrics.maxX);
      return m;
    },
    renderItems() {
      const li = leaderIndex();
      return insts.map((inst, i) => ({
        state: inst.getRenderState(),
        finished: inst.finished,
        isLeader: i === li,
      }));
    },
    metricsList: () => insts.map((i) => i.metrics),
    destroy() {},
  };
}
