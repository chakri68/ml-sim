// Shared Planck (Box2D) scaffolding for every template: the ground, the fixed
// timestep, the collision group that lets a whole population share one world
// without touching each other, and — crucially — a generic metrics tracker.
//
// The tracker is what makes the fitness DSL work across different bodies. A
// template builds its own bodies and drives its own motors, but hands the tracker
// the root body's pose each step plus its energy and per-part ground contacts;
// the tracker derives the body-agnostic metrics (distance, spin, stability,
// jumps, flips, instability, airtime) the same way for a rover or a crawler. No
// template re-implements that math, and every metric means the same thing
// everywhere.

import { Edge, Vec2, World } from "planck";
import { emptyMetrics, type FitnessMetrics } from "./metrics.ts";
import { sampleTerrain } from "./terrain.ts";
import type {
  Genome,
  PhenotypeInstance,
  PhenotypeRenderState,
  Template,
  Terrain,
} from "./types.ts";

export const FIXED_DT = 1 / 60;
export const VEL_ITERS = 8;
export const POS_ITERS = 3;
export const GRAVITY_Y = -10;

// All phenotype parts, across the whole population, share this negative filter
// group, so nothing collides with anything except the ground.
export const SANDBOX_GROUP = -1;

// thresholds shared by the tracker
const SPIN_ANGVEL = 7; // |body angular velocity| above this = spinning
const INSTAB_LINVEL = 34;
const INSTAB_ANGVEL = 22;
const INSTAB_ABORT = 3.0; // accumulated instability-seconds that aborts a run
const STUCK_GRACE = 1.2; // seconds of no progress before "stuck" accrues
const STUCK_ABORT = 3.0; // continuous stuck-seconds that aborts a run
const TWO_PI = Math.PI * 2;

// The procedural ground is infinite; physics only needs edges as far as any
// body could travel in the evaluation window. GROUND_END comfortably exceeds a
// fast rover's reach (≈20 m/s × 20 s), and a body that somehow runs off the end
// simply stops earning distance — a rare, harmless outcome.
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
  anyOnGround: boolean; // is ANY part touching the ground this step
};

export type MetricsTracker = {
  metrics: FitnessMetrics;
  step(sample: MotionSample): void;
  addEnergy(joules: number): void;
  addContact(kind: "body" | "wheel" | "limb", seconds: number): void;
  aborted(): boolean;
};

// spawnX/spawnY are the root body's initial position, so distance and jump
// height are measured relative to where it started.
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
  let minY = spawnY; // lowest point reached so far, for jump height

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

      // uprightness: cos(angle) is 1 level, 0 on its side, -1 upside down
      metrics.stability += Math.max(0, Math.cos(s.angle)) * FIXED_DT;

      if (Math.abs(s.angVel) > SPIN_ANGVEL) metrics.spinTime += FIXED_DT;

      const rotations = Math.abs(s.angle - initialAngle) / TWO_PI;
      metrics.flipCount = Math.floor(rotations);

      // Jump height = the biggest rise above the lowest point reached so far —
      // a genuine hop out of a trough. Measuring against spawn would be wrong for
      // a body (like the Jumper) that spawns at full extension: it starts at its
      // highest pose and could never "exceed" it. Falling just lowers minY, so a
      // body that only drops registers ~0.
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
        exploded ||
        metrics.instability >= INSTAB_ABORT ||
        stuckRun >= STUCK_ABORT
      );
    },
  };
}

// --- single phenotype (headless eval + champion replay) -------------------
export type SandboxSim = {
  step(): void;
  readonly time: number;
  readonly metrics: FitnessMetrics;
  getRenderState(): PhenotypeRenderState;
  bodyX(): number;
  done(): boolean;
  destroy(): void;
};

export function createSingleSim(
  template: Template,
  genome: Genome,
  terrain: Terrain,
): SandboxSim {
  const world = new World({ gravity: { x: 0, y: GRAVITY_Y } });
  buildGround(world, terrain);
  const inst = template.build({
    world,
    genome,
    terrain,
    groupIndex: SANDBOX_GROUP,
  });
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
    destroy() {},
  };
}

// --- whole population in one world (the live race) ------------------------
export type PopulationRenderItem = {
  state: PhenotypeRenderState;
  finished: boolean;
  isLeader: boolean;
};

export type RawResult = { genome: Genome; metrics: FitnessMetrics };

export type PopulationSim = {
  step(): void;
  readonly time: number;
  allDone(): boolean;
  leaderX(): number;
  bestMaxX(): number;
  renderItems(): PopulationRenderItem[];
  rawResults(): RawResult[];
  destroy(): void;
};

export function createPopulationSim(
  template: Template,
  genomes: Genome[],
  terrain: Terrain,
): PopulationSim {
  const world = new World({ gravity: { x: 0, y: GRAVITY_Y } });
  buildGround(world, terrain);
  const insts: PhenotypeInstance[] = genomes.map((g) =>
    template.build({ world, genome: g, terrain, groupIndex: SANDBOX_GROUP }),
  );
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
    rawResults: () =>
      insts.map((inst, i) => ({ genome: genomes[i], metrics: inst.metrics })),
    destroy() {},
  };
}
