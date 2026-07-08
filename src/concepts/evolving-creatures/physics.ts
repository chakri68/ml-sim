// Planck (Box2D) adapter for the two-limbed crawler. Builds a creature — one
// body box plus two limbs, each two segments joined by revolute joints — and
// drives every joint toward a sine-wave target angle.
//
// IMPORTANT: Box2D/Planck revolute-joint motors are VELOCITY motors, not position
// servos. There is no "hold this angle" primitive. So each tick we convert the
// desired angle amplitude*sin(t*freq + phase) into a motor *speed* with a
// proportional controller: speed = clamp(gain * (target - current)). Joint limits
// stop the limbs from winding up infinitely.
//
// Two sims share all of this: createPopulationSim runs the whole generation in
// ONE world (collision-filtered so creatures pass through each other and only
// touch the ground — a shared-world score therefore equals an isolated-world
// score), and createCreatureSim runs a single creature for headless evaluation
// and champion replay. Nothing above this file imports planck.

import { Box, Edge, RevoluteJoint, Vec2, World } from "planck";
import { calculateCreatureFitness } from "./fitness.ts";
import { sampleTerrain, terrainHeight } from "./terrain.ts";
import type {
  CreatureEvaluationResult,
  CreatureGenome,
  Terrain,
} from "./types.ts";

export const FIXED_DT = 1 / 60;
const VEL_ITERS = 8; // more than the cars: creatures have many jointed parts
const POS_ITERS = 3;

const DENSITY = 1.0;
const MOTOR_GAIN = 9; // angle-error -> motor-speed proportional gain
const MAX_MOTOR_SPEED = 9; // rad/s cap on the servo
const MAX_TORQUE = 42; // torque gene (0.2..1) scales this

const FALL_ANGLE = Math.PI * 0.75; // body tipped past this counts as fallen
const SPIN_ANGVEL = 8; // |body angular velocity| above this = spinning
const INSTAB_LINVEL = 34; // runaway linear speed
const INSTAB_ANGVEL = 22; // runaway spin
const INSTAB_ABORT = 3.0; // accumulated instability-seconds that aborts a run
const STUCK_GRACE = 1.0; // seconds of no progress before "stuck" accrues
const STUCK_ABORT = 2.6; // continuous stuck-seconds that aborts a run

const SHOULDER_LIMIT = Math.PI / 2;
const KNEE_LOWER = -2.0; // knee bends mostly one way, like a real knee
const KNEE_UPPER = 0.5;

// All creature parts, across the whole population, share this negative filter
// group, so nothing collides with anything except the ground.
const CREATURE_GROUP = -1;

export type Pt = { x: number; y: number };

export type LimbRenderState = {
  shoulder: Pt;
  knee: Pt;
  foot: Pt;
};

export type CreatureRenderState = {
  body: { x: number; y: number; angle: number; halfW: number; halfH: number };
  limbs: LimbRenderState[]; // [front, rear]
  thickness: number;
  com: Pt;
};

export type LiveMetrics = {
  maxX: number;
  finalX: number;
  averageVelocityX: number;
  timeAlive: number;
  energyUsed: number;
  fellOver: boolean;
  bodyGroundContactSeconds: number;
  excessiveRotationSeconds: number;
  instabilityScore: number;
};

// The procedural ground is infinite; physics only needs edges as far as a
// creature could crawl in the evaluation window (a few metres — creatures are
// slow), so a modest reach keeps the static-edge count low.
const GROUND_START = -6;
const GROUND_END = 120;
const GROUND_STEP = 0.5;

function buildGround(world: World, terrain: Terrain) {
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

function groundYAt(terrain: Terrain, x: number): number {
  return terrainHeight(terrain, x);
}

type JointDrive = {
  joint: RevoluteJoint;
  amp: number;
  phase: number;
  maxTorque: number;
};

type Limb = {
  localShoulder: Vec2; // shoulder anchor in the body's local frame
  upper: ReturnType<World["createDynamicBody"]>;
  lower: ReturnType<World["createDynamicBody"]>;
  upperHalfLen: number;
  lowerHalfLen: number;
  shoulder: JointDrive;
  knee: JointDrive;
};

// One creature living in a (possibly shared) world, with its own metrics.
type CreatureInstance = {
  genome: CreatureGenome;
  metrics: LiveMetrics;
  finished: boolean;
  update(time: number): void; // call once after each world.step, with sim time
  done(): boolean;
  deactivate(): void; // cut the motors once it's out of the running
  getRenderState(): CreatureRenderState;
  bodyX(): number;
};

function buildCreature(
  world: World,
  genome: CreatureGenome,
  terrain: Terrain,
  groupIndex: number,
): CreatureInstance {
  const bodyHalfW = genome.bodyWidth / 2;
  const bodyHalfH = genome.bodyHeight / 2;
  const halfThick = genome.thickness / 2;
  const upperHalfLen = genome.upperLen / 2;
  const lowerHalfLen = genome.lowerLen / 2;

  // Spawn so the legs hang straight down with the feet just above the ground.
  const spawnX = 0;
  const legReach = genome.upperLen + genome.lowerLen;
  const spawnY = groundYAt(terrain, spawnX) + bodyHalfH + legReach + 0.06;
  const bottomLocalY = -bodyHalfH; // body's underside in local coords

  const body = world.createDynamicBody({ position: { x: spawnX, y: spawnY } });
  body.createFixture({
    shape: new Box(bodyHalfW, bodyHalfH),
    density: DENSITY,
    friction: 0.6,
    filterGroupIndex: groupIndex,
  });

  function buildLimb(
    sign: number,
    torqueGene: number,
    shoulderAmp: number,
    shoulderPhase: number,
    kneeAmp: number,
    kneePhase: number,
  ): Limb {
    const attachX = spawnX + sign * genome.limbAttach * bodyHalfW;
    const attachY = spawnY + bottomLocalY;
    const localShoulder = new Vec2(
      sign * genome.limbAttach * bodyHalfW,
      bottomLocalY,
    );

    const upper = world.createDynamicBody({
      position: { x: attachX, y: attachY - upperHalfLen },
    });
    upper.createFixture({
      shape: new Box(halfThick, upperHalfLen),
      density: DENSITY,
      friction: 0.9,
      filterGroupIndex: groupIndex,
    });
    const lower = world.createDynamicBody({
      position: { x: attachX, y: attachY - genome.upperLen - lowerHalfLen },
    });
    lower.createFixture({
      shape: new Box(halfThick, lowerHalfLen),
      density: DENSITY,
      friction: 0.95, // the foot: grippy, so it can push off
      filterGroupIndex: groupIndex,
    });

    const maxTorque = torqueGene * MAX_TORQUE;

    const shoulderJoint = new RevoluteJoint(
      {
        enableMotor: true,
        enableLimit: true,
        lowerAngle: -SHOULDER_LIMIT,
        upperAngle: SHOULDER_LIMIT,
        maxMotorTorque: maxTorque,
        motorSpeed: 0,
      },
      body,
      upper,
      new Vec2(attachX, attachY),
    );
    world.createJoint(shoulderJoint);

    const kneeJoint = new RevoluteJoint(
      {
        enableMotor: true,
        enableLimit: true,
        lowerAngle: KNEE_LOWER,
        upperAngle: KNEE_UPPER,
        maxMotorTorque: maxTorque,
        motorSpeed: 0,
      },
      upper,
      lower,
      new Vec2(attachX, attachY - genome.upperLen),
    );
    world.createJoint(kneeJoint);

    return {
      localShoulder,
      upper,
      lower,
      upperHalfLen,
      lowerHalfLen,
      shoulder: {
        joint: shoulderJoint,
        amp: shoulderAmp,
        phase: shoulderPhase,
        maxTorque,
      },
      knee: { joint: kneeJoint, amp: kneeAmp, phase: kneePhase, maxTorque },
    };
  }

  const front = buildLimb(
    1,
    genome.frontTorque,
    genome.frontShoulderAmp,
    genome.frontShoulderPhase,
    genome.frontKneeAmp,
    genome.frontKneePhase,
  );
  const rear = buildLimb(
    -1,
    genome.rearTorque,
    genome.rearShoulderAmp,
    genome.rearShoulderPhase,
    genome.rearKneeAmp,
    genome.rearKneePhase,
  );
  const limbs = [front, rear];
  const freq = genome.gaitFrequency;

  const metrics: LiveMetrics = {
    maxX: 0,
    finalX: 0,
    averageVelocityX: 0,
    timeAlive: 0,
    energyUsed: 0,
    fellOver: false,
    bodyGroundContactSeconds: 0,
    excessiveRotationSeconds: 0,
    instabilityScore: 0,
  };
  let sinceProgress = 0;
  let stuckRun = 0;
  let velSum = 0;
  let steps = 0;
  let exploded = false;
  let active = true;

  const wrap = (a: number) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };

  function driveJoint(d: JointDrive, time: number) {
    const target = d.amp * Math.sin(time * freq + d.phase);
    const current = d.joint.getJointAngle();
    const speed = Math.max(
      -MAX_MOTOR_SPEED,
      Math.min(MAX_MOTOR_SPEED, MOTOR_GAIN * (target - current)),
    );
    d.joint.setMotorSpeed(speed);
    // work ~ |applied torque * angular displacement this step|
    metrics.energyUsed +=
      Math.abs(d.joint.getJointSpeed()) * d.maxTorque * FIXED_DT;
  }

  return {
    genome,
    metrics,
    finished: false,
    bodyX: () => body.getPosition().x,
    update(time: number) {
      if (active) {
        for (const limb of limbs) {
          driveJoint(limb.shoulder, time);
          driveJoint(limb.knee, time);
        }
      }
      steps++;
      metrics.timeAlive += FIXED_DT;

      const pos = body.getPosition();
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.y < -30)
        exploded = true;
      const x = pos.x - spawnX;
      metrics.finalX = x;
      if (x > metrics.maxX + 0.02) {
        metrics.maxX = x;
        sinceProgress = 0;
        stuckRun = 0;
      } else {
        sinceProgress += FIXED_DT;
        if (sinceProgress > STUCK_GRACE) stuckRun += FIXED_DT;
      }

      if (Math.abs(wrap(body.getAngle())) > FALL_ANGLE) metrics.fellOver = true;

      const angVel = body.getAngularVelocity();
      if (Math.abs(angVel) > SPIN_ANGVEL)
        metrics.excessiveRotationSeconds += FIXED_DT;

      const linVel = body.getLinearVelocity();
      if (
        Math.abs(linVel.x) > INSTAB_LINVEL ||
        Math.abs(linVel.y) > INSTAB_LINVEL ||
        Math.abs(angVel) > INSTAB_ANGVEL
      ) {
        metrics.instabilityScore += FIXED_DT;
      }

      // body-ground contact (the body can only touch the ground — not its own
      // limbs or other creatures)
      let onGround = false;
      for (let ce = body.getContactList(); ce; ce = ce.next) {
        if (ce.contact.isTouching()) {
          onGround = true;
          break;
        }
      }
      if (onGround) metrics.bodyGroundContactSeconds += FIXED_DT;

      velSum += linVel.x;
      metrics.averageVelocityX = velSum / steps;
    },
    done() {
      return (
        exploded ||
        metrics.instabilityScore >= INSTAB_ABORT ||
        stuckRun >= STUCK_ABORT
      );
    },
    deactivate() {
      active = false;
      for (const limb of limbs) {
        limb.shoulder.joint.enableMotor(false);
        limb.knee.joint.enableMotor(false);
      }
    },
    getRenderState(): CreatureRenderState {
      const bp = body.getPosition();
      const limbStates = limbs.map((limb) => {
        const shoulder = body.getWorldPoint(limb.localShoulder);
        const knee = limb.upper.getWorldPoint(new Vec2(0, -limb.upperHalfLen));
        const foot = limb.lower.getWorldPoint(new Vec2(0, -limb.lowerHalfLen));
        return {
          shoulder: { x: shoulder.x, y: shoulder.y },
          knee: { x: knee.x, y: knee.y },
          foot: { x: foot.x, y: foot.y },
        };
      });
      // center of mass of the whole creature (mass-weighted)
      let mx = 0;
      let my = 0;
      let mtot = 0;
      for (const b of [
        body,
        front.upper,
        front.lower,
        rear.upper,
        rear.lower,
      ]) {
        const m = b.getMass();
        const c = b.getWorldCenter();
        mx += c.x * m;
        my += c.y * m;
        mtot += m;
      }
      return {
        body: {
          x: bp.x,
          y: bp.y,
          angle: body.getAngle(),
          halfW: bodyHalfW,
          halfH: bodyHalfH,
        },
        limbs: limbStates,
        thickness: genome.thickness,
        com: { x: mx / mtot, y: my / mtot },
      };
    },
  };
}

function toResult(inst: CreatureInstance): CreatureEvaluationResult {
  const m = inst.metrics;
  const result: CreatureEvaluationResult = {
    genome: inst.genome,
    maxX: m.maxX,
    finalX: m.finalX,
    averageVelocityX: m.averageVelocityX,
    timeAlive: m.timeAlive,
    energyUsed: m.energyUsed,
    fellOver: m.fellOver,
    bodyGroundContactSeconds: m.bodyGroundContactSeconds,
    excessiveRotationSeconds: m.excessiveRotationSeconds,
    instabilityScore: m.instabilityScore,
    fitness: 0,
  };
  result.fitness = calculateCreatureFitness(result);
  return result;
}

// --- single creature (headless eval + champion replay) --------------------
export type CreatureSim = {
  step(): void;
  readonly time: number;
  readonly metrics: LiveMetrics;
  getRenderState(): CreatureRenderState;
  bodyX(): number;
  done(): boolean;
  destroy(): void;
};

export function createCreatureSim(
  genome: CreatureGenome,
  terrain: Terrain,
): CreatureSim {
  const world = new World({ gravity: { x: 0, y: -10 } });
  buildGround(world, terrain);
  const inst = buildCreature(world, genome, terrain, CREATURE_GROUP);
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
  state: CreatureRenderState;
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
  results(): CreatureEvaluationResult[];
  destroy(): void;
};

export function createPopulationSim(
  genomes: CreatureGenome[],
  terrain: Terrain,
): PopulationSim {
  const world = new World({ gravity: { x: 0, y: -10 } });
  buildGround(world, terrain);
  const insts = genomes.map((g) =>
    buildCreature(world, g, terrain, CREATURE_GROUP),
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
      for (const inst of insts) {
        if (!inst.finished) inst.update(time);
      }
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
    results: () => insts.map(toResult),
    destroy() {},
  };
}
