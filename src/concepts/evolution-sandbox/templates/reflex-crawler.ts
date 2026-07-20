// Reflex Crawler: the same two-limbed body as the Crawler, but the gait is
// closed-loop. The Crawler plays a fixed tune — each joint target is
// amp*sin(t*freq + phase), a function of the clock and nothing else, so it reacts
// to nothing the world does to it. Here each limb reads the body's tilt and bends
// its cycle to it two ways:
//
//   • phase modulation ("when it moves"): body tilt speeds up or slows down that
//     limb's leg cycle. This is a CPG (central pattern generator) with afferent
//     feedback — the biologically honest version — so it can never freeze at a
//     fixed point: the oscillator always ticks, feedback only shapes it.
//   • posture offset ("how far it reaches"): body tilt shifts the shoulder target,
//     a lean-correction reflex.
//
// Both feedback gains default to 0, so with no evolution this behaves EXACTLY like
// the Crawler. That guarantees motion from step one and makes evolution's job to
// *discover* the reactivity, not depend on it. Sits between the open-loop sine
// Crawler and a full evolved neural controller.

import { Box, RevoluteJoint, Vec2, type World } from "planck";
import { createMetricsTracker, FIXED_DT } from "../physics.ts";
import { terrainHeight } from "../terrain.ts";
import type {
  Genome,
  PhenotypeInstance,
  PhenotypeRenderState,
  Template,
  Terrain,
} from "../types.ts";

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

const DENSITY = 1.0;
const MOTOR_GAIN = 9; // angle-error -> motor-speed proportional gain
const MAX_MOTOR_SPEED = 9;
const MAX_TORQUE = 42; // torque gene (0.2..1) scales this
const SHOULDER_LIMIT = Math.PI / 2;
const KNEE_LOWER = -2.0; // knee bends mostly one way
const KNEE_UPPER = 0.5;

// Feedback safety: the tilt-modulated frequency multiplier is clamped to this
// band so a big gain × big tilt can't reverse the leg cycle or stall it dead.
const PHASE_MOD_MIN = 0.2;
const PHASE_MOD_MAX = 2.0;

const GENES: Template["genes"] = [
  {
    key: "bodyWidth",
    group: "Body",
    label: "Body width",
    min: 1.0,
    max: 3.0,
    defaultValue: 1.8,
    unit: "m",
  },
  {
    key: "bodyHeight",
    group: "Body",
    label: "Body height",
    min: 0.3,
    max: 1.0,
    defaultValue: 0.5,
    unit: "m",
  },
  {
    key: "limbAttach",
    group: "Limbs",
    label: "Limb spread",
    min: 0.2,
    max: 0.95,
    defaultValue: 0.6,
  },
  {
    key: "upperLen",
    group: "Limbs",
    label: "Upper length",
    min: 0.35,
    max: 1.4,
    defaultValue: 0.8,
    unit: "m",
  },
  {
    key: "lowerLen",
    group: "Limbs",
    label: "Lower length",
    min: 0.35,
    max: 1.4,
    defaultValue: 0.8,
    unit: "m",
  },
  {
    key: "thickness",
    group: "Limbs",
    label: "Thickness",
    min: 0.1,
    max: 0.3,
    defaultValue: 0.18,
    unit: "m",
  },
  {
    key: "gaitFrequency",
    group: "Gait",
    label: "Gait tempo",
    min: 1.5,
    max: 7.0,
    defaultValue: 4,
    unit: "rad/s",
  },
  {
    key: "frontShoulderAmp",
    group: "Front Motors",
    label: "Shoulder swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.5,
    display: "pi",
  },
  {
    key: "frontShoulderPhase",
    group: "Front Motors",
    label: "Shoulder phase",
    min: 0,
    max: TWO_PI,
    defaultValue: 0,
    display: "pi",
  },
  {
    key: "frontKneeAmp",
    group: "Front Motors",
    label: "Knee swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.5,
    display: "pi",
  },
  {
    key: "frontKneePhase",
    group: "Front Motors",
    label: "Knee phase",
    min: 0,
    max: TWO_PI,
    defaultValue: Math.PI,
    display: "pi",
  },
  {
    key: "frontTorque",
    group: "Front Motors",
    label: "Muscle strength",
    min: 0.2,
    max: 1.0,
    defaultValue: 0.6,
  },
  {
    key: "rearShoulderAmp",
    group: "Rear Motors",
    label: "Shoulder swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.5,
    display: "pi",
  },
  {
    key: "rearShoulderPhase",
    group: "Rear Motors",
    label: "Shoulder phase",
    min: 0,
    max: TWO_PI,
    defaultValue: Math.PI,
    display: "pi",
  },
  {
    key: "rearKneeAmp",
    group: "Rear Motors",
    label: "Knee swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.5,
    display: "pi",
  },
  {
    key: "rearKneePhase",
    group: "Rear Motors",
    label: "Knee phase",
    min: 0,
    max: TWO_PI,
    defaultValue: 0,
    display: "pi",
  },
  {
    key: "rearTorque",
    group: "Rear Motors",
    label: "Muscle strength",
    min: 0.2,
    max: 1.0,
    defaultValue: 0.6,
  },
  // --- the reflex genes: how strongly body tilt bends each limb's cycle. All
  // default to 0, so an unevolved Reflex Crawler == the Crawler.
  {
    key: "frontTiltPhase",
    group: "Front Reflex",
    label: "Tilt → tempo",
    min: -1.5,
    max: 1.5,
    defaultValue: 0,
  },
  {
    key: "frontTiltPosture",
    group: "Front Reflex",
    label: "Tilt → reach",
    min: -1.0,
    max: 1.0,
    defaultValue: 0,
    display: "pi",
  },
  {
    key: "rearTiltPhase",
    group: "Rear Reflex",
    label: "Tilt → tempo",
    min: -1.5,
    max: 1.5,
    defaultValue: 0,
  },
  {
    key: "rearTiltPosture",
    group: "Rear Reflex",
    label: "Tilt → reach",
    min: -1.0,
    max: 1.0,
    defaultValue: 0,
    display: "pi",
  },
];

type Body = ReturnType<World["createDynamicBody"]>;
type JointDrive = {
  joint: RevoluteJoint;
  amp: number;
  phase: number;
  maxTorque: number;
};
type Limb = {
  localShoulder: Vec2;
  upper: Body;
  lower: Body;
  upperHalfLen: number;
  lowerHalfLen: number;
  shoulder: JointDrive;
  knee: JointDrive;
  tiltPhaseGain: number; // body tilt -> frequency multiplier ("when")
  tiltPostureGain: number; // body tilt -> shoulder target offset ("how far")
  phaseAcc: number; // this limb's own integrated phase (the CPG clock)
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function build(params: {
  world: World;
  genome: Genome;
  terrain: Terrain;
  groupIndex: number;
}): PhenotypeInstance {
  const { world, genome, terrain, groupIndex } = params;
  const bodyHalfW = genome.bodyWidth / 2;
  const bodyHalfH = genome.bodyHeight / 2;
  const halfThick = genome.thickness / 2;
  const upperHalfLen = genome.upperLen / 2;
  const lowerHalfLen = genome.lowerLen / 2;
  const freq = genome.gaitFrequency;

  const spawnX = 0;
  const legReach = genome.upperLen + genome.lowerLen;
  const spawnY = terrainHeight(terrain, spawnX) + bodyHalfH + legReach + 0.06;
  const bottomLocalY = -bodyHalfH;

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
    tiltPhaseGain: number,
    tiltPostureGain: number,
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
      friction: 0.95,
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
      tiltPhaseGain,
      tiltPostureGain,
      phaseAcc: 0,
    };
  }

  const front = buildLimb(
    1,
    genome.frontTorque,
    genome.frontShoulderAmp,
    genome.frontShoulderPhase,
    genome.frontKneeAmp,
    genome.frontKneePhase,
    genome.frontTiltPhase,
    genome.frontTiltPosture,
  );
  const rear = buildLimb(
    -1,
    genome.rearTorque,
    genome.rearShoulderAmp,
    genome.rearShoulderPhase,
    genome.rearKneeAmp,
    genome.rearKneePhase,
    genome.rearTiltPhase,
    genome.rearTiltPosture,
  );
  const limbs = [front, rear];

  const tracker = createMetricsTracker(spawnX, spawnY);
  let active = true;

  function touching(b: Body): boolean {
    for (let ce = b.getContactList(); ce; ce = ce.next)
      if (ce.contact.isTouching()) return true;
    return false;
  }

  // Servo a joint to `amp*sin(phase + phaseOffset) + targetOffset`, converting
  // the target-angle error into a motor speed (Box2D motors are velocity motors).
  function driveJoint(d: JointDrive, phase: number, targetOffset: number) {
    const target = d.amp * Math.sin(phase + d.phase) + targetOffset;
    const current = d.joint.getJointAngle();
    const speed = clamp(
      MOTOR_GAIN * (target - current),
      -MAX_MOTOR_SPEED,
      MAX_MOTOR_SPEED,
    );
    d.joint.setMotorSpeed(speed);
    tracker.addEnergy(
      Math.abs(d.joint.getJointSpeed()) * d.maxTorque * FIXED_DT,
    );
  }

  function driveLimb(limb: Limb, tilt: number) {
    // Drive at the CURRENT phase, THEN advance it. Order matters: with the
    // reflex gains at 0 this must reproduce the Crawler exactly, and the Crawler
    // evaluates sin(freq*time) at the pre-step time — so step 0 must use
    // phaseAcc == 0, not a phase already nudged forward one tick.
    const posture = limb.tiltPostureGain * tilt;
    driveJoint(limb.shoulder, limb.phaseAcc, posture);
    driveJoint(limb.knee, limb.phaseAcc, 0);
    // Tilt bends the tempo: mod<1 slows this limb's cycle, mod>1 speeds it, but
    // clamped so feedback can never reverse or stall the oscillator.
    const mod = clamp(
      1 + limb.tiltPhaseGain * tilt,
      PHASE_MOD_MIN,
      PHASE_MOD_MAX,
    );
    limb.phaseAcc += freq * mod * FIXED_DT;
  }

  return {
    metrics: tracker.metrics,
    finished: false,
    bodyX: () => body.getPosition().x,
    update() {
      if (active) {
        const tilt = body.getAngle();
        for (const limb of limbs) driveLimb(limb, tilt);
      }
      let anyGround = touching(body);
      if (anyGround) tracker.addContact("body", FIXED_DT);
      for (const limb of limbs) {
        for (const seg of [limb.upper, limb.lower]) {
          if (touching(seg)) {
            anyGround = true;
            tracker.addContact("limb", FIXED_DT);
          }
        }
      }
      const pos = body.getPosition();
      const vel = body.getLinearVelocity();
      tracker.step({
        x: pos.x,
        y: pos.y,
        angle: body.getAngle(),
        vx: vel.x,
        vy: vel.y,
        angVel: body.getAngularVelocity(),
        anyOnGround: anyGround,
      });
    },
    done: () => tracker.aborted(),
    deactivate() {
      active = false;
      for (const limb of limbs) {
        limb.shoulder.joint.enableMotor(false);
        limb.knee.joint.enableMotor(false);
      }
    },
    getRenderState(): PhenotypeRenderState {
      const bp = body.getPosition();
      const parts: PhenotypeRenderState["parts"] = [
        {
          kind: "box",
          x: bp.x,
          y: bp.y,
          angle: body.getAngle(),
          halfW: bodyHalfW,
          halfH: bodyHalfH,
          role: "body",
        },
      ];
      const joints: PhenotypeRenderState["joints"] = [];
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
      for (const limb of limbs) {
        const up = limb.upper.getPosition();
        const lo = limb.lower.getPosition();
        parts.push({
          kind: "box",
          x: up.x,
          y: up.y,
          angle: limb.upper.getAngle(),
          halfW: halfThick,
          halfH: limb.upperHalfLen,
          role: "limb",
        });
        parts.push({
          kind: "box",
          x: lo.x,
          y: lo.y,
          angle: limb.lower.getAngle(),
          halfW: halfThick,
          halfH: limb.lowerHalfLen,
          role: "limb",
        });
        const shoulder = body.getWorldPoint(limb.localShoulder);
        const knee = limb.upper.getWorldPoint(new Vec2(0, -limb.upperHalfLen));
        joints.push({ x: shoulder.x, y: shoulder.y }, { x: knee.x, y: knee.y });
      }
      return { parts, joints, com: { x: mx / mtot, y: my / mtot } };
    },
  };
}

export const reflexCrawlerTemplate: Template = {
  id: "reflex-crawler",
  label: "Reflex Crawler",
  subtitle:
    "The Crawler's body, but each leg's timing and reach bend to the body's tilt — a closed-loop gait instead of a blind sine wave.",
  genes: GENES,
  geneGroups: [
    "Body",
    "Limbs",
    "Gait",
    "Front Motors",
    "Rear Motors",
    "Front Reflex",
    "Rear Reflex",
  ],
  recommendedFitness: "go-far",
  meaningfulMetrics: [
    "distance",
    "maxX",
    "finalX",
    "averageSpeed",
    "survivalTime",
    "energyUsed",
    "spinTime",
    "flipCount",
    "jumpHeight",
    "airtime",
    "bodyGroundContactTime",
    "limbGroundContactTime",
    "stability",
    "instability",
  ],
  build,
};
