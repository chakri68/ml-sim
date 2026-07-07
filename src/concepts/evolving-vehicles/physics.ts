// Planck (Box2D) adapter. Builds vehicles + terrain and exposes two sims that
// both step at the SAME fixed timestep:
//   - createPopulationSim: the whole generation in ONE world, driven live and
//     rendered (cars are collision-filtered so they pass through each other).
//   - createVehicleSim: a single vehicle, for headless evaluation and best-ever
//     replay.
// Because vehicles never collide with each other, a shared-world result matches
// an isolated-world result exactly — so the watched race and the headless
// fast-forward score genomes identically. Nothing above this file imports planck.

import { Circle, Edge, Polygon, Vec2, WheelJoint, World } from "planck";
import { calculateFitness } from "./fitness.ts";
import type {
  Terrain,
  VehicleEvaluationResult,
  VehicleGenome,
} from "./types.ts";

export const FIXED_DT = 1 / 60;
const VEL_ITERS = 6;
const POS_ITERS = 2;

const MOTOR_SPEED = 14;
const MOTOR_TORQUE_MAX = 34;
const SUS_FREQ = (t: number) => 3 + t * 5;
const SUS_DAMP = 0.7;

const FLIP_ANGLE = 2.5;
const STUCK_GRACE = 0.6;
const STUCK_ABORT = 2.0;

// All vehicles share this negative filter group, so no two vehicles ever
// collide with each other — only with the ground (group 0).
const VEHICLE_GROUP = -1;

export type WheelRenderState = {
  x: number;
  y: number;
  angle: number;
  radius: number;
};

export type VehicleRenderState = {
  chassis: { x: number; y: number; angle: number };
  chassisVerts: { x: number; y: number }[];
  frontWheel: WheelRenderState;
  rearWheel: WheelRenderState;
};

export type LiveMetrics = {
  maxX: number;
  finalX: number;
  timeAlive: number;
  flipped: boolean;
  stuckSeconds: number;
  motorEnergy: number;
  chassisContactSeconds: number;
  averageVelocityX: number;
};

function chassisVertices(genome: VehicleGenome): Vec2[] {
  const hw = genome.chassisWidth / 2;
  const hh = genome.chassisHeight / 2;
  return [
    new Vec2(-hw, -hh),
    new Vec2(hw, -hh),
    new Vec2(hw, hh * genome.chassisFrontScale),
    new Vec2(-hw, hh * genome.chassisRearScale),
  ];
}

function buildGround(world: World, terrain: Terrain) {
  const ground = world.createBody({ type: "static" });
  for (let i = 0; i < terrain.points.length - 1; i++) {
    const a = terrain.points[i];
    const b = terrain.points[i + 1];
    ground.createFixture({
      shape: new Edge(new Vec2(a.x, a.y), new Vec2(b.x, b.y)),
      friction: 0.9,
    });
  }
}

// One vehicle living in a (possibly shared) world, with its own metrics.
type VehicleInstance = {
  genome: VehicleGenome;
  metrics: LiveMetrics;
  finished: boolean;
  update(): void; // call once after each world.step
  done(): boolean;
  deactivate(): void; // cut the motors once it's out of the running
  getRenderState(): VehicleRenderState;
  chassisX(): number;
};

function buildVehicle(
  world: World,
  genome: VehicleGenome,
  groupIndex: number,
): VehicleInstance {
  const verts = chassisVertices(genome);
  const localVerts = verts.map((v) => ({ x: v.x, y: v.y }));
  const hh = genome.chassisHeight / 2;
  const maxR = Math.max(genome.frontWheelRadius, genome.rearWheelRadius);
  const spawnX = 0;
  const spawnY = maxR + hh + 0.4;

  const chassis = world.createDynamicBody({
    position: { x: spawnX, y: spawnY },
  });
  chassis.createFixture({
    shape: new Polygon(verts),
    density: 1.1,
    friction: 0.3,
    filterGroupIndex: groupIndex,
  });

  function makeWheel(
    radius: number,
    localX: number,
    torqueGene: number,
    susGene: number,
  ) {
    const wx = spawnX + localX * genome.chassisWidth;
    const wy = spawnY - hh - radius * 0.4;
    const wheel = world.createDynamicBody({ position: { x: wx, y: wy } });
    wheel.createFixture({
      shape: new Circle(radius),
      density: 1,
      friction: 0.95,
      filterGroupIndex: groupIndex,
    });
    const joint = new WheelJoint(
      {
        enableMotor: torqueGene > 0.02,
        motorSpeed: -MOTOR_SPEED,
        maxMotorTorque: torqueGene * MOTOR_TORQUE_MAX,
        frequencyHz: SUS_FREQ(susGene),
        dampingRatio: SUS_DAMP,
      },
      chassis,
      wheel,
      wheel.getPosition(),
      new Vec2(0, 1),
    );
    world.createJoint(joint);
    return { wheel, radius, joint, maxTorque: torqueGene * MOTOR_TORQUE_MAX };
  }

  const front = makeWheel(
    genome.frontWheelRadius,
    genome.frontWheelX,
    genome.frontMotorTorque,
    genome.frontSuspension,
  );
  const rear = makeWheel(
    genome.rearWheelRadius,
    genome.rearWheelX,
    genome.rearMotorTorque,
    genome.rearSuspension,
  );

  const metrics: LiveMetrics = {
    maxX: 0,
    finalX: 0,
    timeAlive: 0,
    flipped: false,
    stuckSeconds: 0,
    motorEnergy: 0,
    chassisContactSeconds: 0,
    averageVelocityX: 0,
  };
  let sinceProgress = 0;
  let stuckRun = 0;
  let velSum = 0;
  let steps = 0;
  let exploded = false;

  const wrap = (a: number) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };

  const inst: VehicleInstance = {
    genome,
    metrics,
    finished: false,
    chassisX: () => chassis.getPosition().x,
    update() {
      steps++;
      metrics.timeAlive += FIXED_DT;
      const pos = chassis.getPosition();
      const x = pos.x - spawnX;
      metrics.finalX = x;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.y < -30)
        exploded = true;

      if (x > metrics.maxX + 0.02) {
        metrics.maxX = x;
        sinceProgress = 0;
        stuckRun = 0;
      } else {
        sinceProgress += FIXED_DT;
        if (sinceProgress > STUCK_GRACE) {
          metrics.stuckSeconds += FIXED_DT;
          stuckRun += FIXED_DT;
        }
      }

      if (Math.abs(wrap(chassis.getAngle())) > FLIP_ANGLE)
        metrics.flipped = true;

      metrics.motorEnergy +=
        (front.maxTorque * Math.abs(front.wheel.getAngularVelocity()) +
          rear.maxTorque * Math.abs(rear.wheel.getAngularVelocity())) *
        FIXED_DT;

      // chassis-ground contact: the chassis can only touch the ground (it can't
      // collide with its own jointed wheels or with other vehicles)
      let onGround = false;
      for (let ce = chassis.getContactList(); ce; ce = ce.next) {
        if (ce.contact.isTouching()) {
          onGround = true;
          break;
        }
      }
      if (onGround) metrics.chassisContactSeconds += FIXED_DT;

      velSum += chassis.getLinearVelocity().x;
      metrics.averageVelocityX = velSum / steps;
    },
    done() {
      return exploded || metrics.flipped || stuckRun >= STUCK_ABORT;
    },
    deactivate() {
      front.joint.enableMotor(false);
      rear.joint.enableMotor(false);
    },
    getRenderState() {
      const cp = chassis.getPosition();
      const fp = front.wheel.getPosition();
      const rp = rear.wheel.getPosition();
      return {
        chassis: { x: cp.x, y: cp.y, angle: chassis.getAngle() },
        chassisVerts: localVerts,
        frontWheel: {
          x: fp.x,
          y: fp.y,
          angle: front.wheel.getAngle(),
          radius: front.radius,
        },
        rearWheel: {
          x: rp.x,
          y: rp.y,
          angle: rear.wheel.getAngle(),
          radius: rear.radius,
        },
      };
    },
  };
  return inst;
}

function toResult(inst: VehicleInstance): VehicleEvaluationResult {
  const m = inst.metrics;
  const result: VehicleEvaluationResult = {
    genome: inst.genome,
    maxX: m.maxX,
    finalX: m.finalX,
    averageVelocityX: m.averageVelocityX,
    timeAlive: m.timeAlive,
    flipped: m.flipped,
    stuckSeconds: m.stuckSeconds,
    motorEnergy: m.motorEnergy,
    chassisContactSeconds: m.chassisContactSeconds,
    fitness: 0,
  };
  result.fitness = calculateFitness(result);
  return result;
}

// --- single vehicle (headless eval + best-ever replay) --------------------
export type VehicleSim = {
  step(): void;
  readonly metrics: LiveMetrics;
  getRenderState(): VehicleRenderState;
  done(): boolean;
  destroy(): void;
};

export function createVehicleSim(
  genome: VehicleGenome,
  terrain: Terrain,
): VehicleSim {
  const world = new World({ gravity: { x: 0, y: -10 } });
  buildGround(world, terrain);
  const inst = buildVehicle(world, genome, 0);
  return {
    step() {
      world.step(FIXED_DT, VEL_ITERS, POS_ITERS);
      inst.update();
    },
    metrics: inst.metrics,
    getRenderState: () => inst.getRenderState(),
    done: () => inst.done(),
    destroy() {},
  };
}

// --- whole population in one world (the live race) ------------------------
export type PopulationRenderItem = {
  state: VehicleRenderState;
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
  results(): VehicleEvaluationResult[];
  destroy(): void;
};

export function createPopulationSim(
  genomes: VehicleGenome[],
  terrain: Terrain,
): PopulationSim {
  const world = new World({ gravity: { x: 0, y: -10 } });
  buildGround(world, terrain);
  const insts = genomes.map((g) => buildVehicle(world, g, VEHICLE_GROUP));
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
      world.step(FIXED_DT, VEL_ITERS, POS_ITERS);
      time += FIXED_DT;
      for (const inst of insts) {
        if (inst.finished) continue;
        inst.update();
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
      for (const i of insts) m = Math.max(m, i.chassisX());
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
    results: () => insts.map(toResult),
    destroy() {},
  };
}
