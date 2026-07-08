// Two-Limbed Crawler: a body with two limbs, each two segments joined by
// revolute joints driven by sine-wave motors. This exercises Planck's revolute
// motor as a position servo (Box2D motors are velocity motors, so each tick we
// convert a target angle amplitude*sin(t*freq + phase) into a motor speed via a
// proportional controller). Ported from Evolving Creatures into the generic
// template interface.

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
};

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

  const tracker = createMetricsTracker(spawnX, spawnY);
  let active = true;

  function touching(b: Body): boolean {
    for (let ce = b.getContactList(); ce; ce = ce.next)
      if (ce.contact.isTouching()) return true;
    return false;
  }

  function driveJoint(d: JointDrive, time: number) {
    const target = d.amp * Math.sin(time * freq + d.phase);
    const current = d.joint.getJointAngle();
    const speed = Math.max(
      -MAX_MOTOR_SPEED,
      Math.min(MAX_MOTOR_SPEED, MOTOR_GAIN * (target - current)),
    );
    d.joint.setMotorSpeed(speed);
    tracker.addEnergy(
      Math.abs(d.joint.getJointSpeed()) * d.maxTorque * FIXED_DT,
    );
  }

  return {
    metrics: tracker.metrics,
    finished: false,
    bodyX: () => body.getPosition().x,
    update(time: number) {
      if (active) {
        for (const limb of limbs) {
          driveJoint(limb.shoulder, time);
          driveJoint(limb.knee, time);
        }
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

export const crawlerTemplate: Template = {
  id: "two-limbed-crawler",
  label: "Two-Limbed Crawler",
  subtitle:
    "A body with two jointed limbs driven by sine-wave motors. Evolves a gait from scratch.",
  genes: GENES,
  geneGroups: ["Body", "Limbs", "Gait", "Front Motors", "Rear Motors"],
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
