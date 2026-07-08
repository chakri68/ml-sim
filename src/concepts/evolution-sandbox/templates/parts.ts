// Reusable physics building blocks shared by the composed templates (Hybrid,
// Jumper, Flipper). Each helper creates its planck bodies + joints and returns a
// small handle that knows how to drive itself for one step (returning the motor
// work it did, so the template can feed the metrics tracker), report ground
// contact, and render itself as generic RenderParts. This keeps each template a
// short assembly of parts rather than a re-implementation of the servo/wheel
// physics.

import {
  Box,
  Circle,
  RevoluteJoint,
  Vec2,
  WheelJoint,
  type World,
} from "planck";
import { FIXED_DT } from "../physics.ts";
import type { PhenotypeRenderState, RenderPart } from "../types.ts";

type Body = ReturnType<World["createDynamicBody"]>;
type Pt = PhenotypeRenderState["joints"][number];

export const DENSITY = 1.0;

// limb (two-segment leg) constants — mirror the standalone crawler template
const LIMB_GAIN = 9; // angle-error -> motor-speed proportional gain
const LIMB_MAX_SPEED = 9;
export const LIMB_MAX_TORQUE = 48; // torque gene scales this
const SHOULDER_LIMIT = Math.PI / 2;
const KNEE_LOWER = -2.2;
const KNEE_UPPER = 0.6;

// wheel constants — mirror the rover template
const WHEEL_MOTOR_SPEED = 16;
export const WHEEL_MOTOR_TORQUE_MAX = 55;

const SEG_MAX_SPEED = 10;

export function touching(body: Body): boolean {
  for (let ce = body.getContactList(); ce; ce = ce.next) {
    if (ce.contact.isTouching()) return true;
  }
  return false;
}

export function comOf(bodies: Body[]): Pt {
  let mx = 0;
  let my = 0;
  let mt = 0;
  for (const b of bodies) {
    const m = b.getMass();
    const c = b.getWorldCenter();
    mx += c.x * m;
    my += c.y * m;
    mt += m;
  }
  return { x: mx / mt, y: my / mt };
}

// ---------------------------------------------------------------- limb
export type LimbPart = {
  bodies: Body[];
  drive(time: number, freq: number): number; // returns motor work this step
  disable(): void;
  renderParts(): RenderPart[];
  jointPoints(): Pt[];
};

export function buildLimb(
  world: World,
  opts: {
    body: Body;
    group: number;
    attachLocal: Vec2; // shoulder anchor in the body's local frame
    attachWorld: Vec2; // same point in world coords at spawn
    upperLen: number;
    lowerLen: number;
    thickness: number;
    torqueGene: number;
    shoulderAmp: number;
    shoulderPhase: number;
    kneeAmp: number;
    kneePhase: number;
  },
): LimbPart {
  const halfThick = opts.thickness / 2;
  const upperHalf = opts.upperLen / 2;
  const lowerHalf = opts.lowerLen / 2;
  const ax = opts.attachWorld.x;
  const ay = opts.attachWorld.y;

  const upper = world.createDynamicBody({
    position: { x: ax, y: ay - upperHalf },
  });
  upper.createFixture({
    shape: new Box(halfThick, upperHalf),
    density: DENSITY,
    friction: 0.9,
    filterGroupIndex: opts.group,
  });
  const lower = world.createDynamicBody({
    position: { x: ax, y: ay - opts.upperLen - lowerHalf },
  });
  lower.createFixture({
    shape: new Box(halfThick, lowerHalf),
    density: DENSITY,
    friction: 0.95,
    filterGroupIndex: opts.group,
  });

  const maxTorque = opts.torqueGene * LIMB_MAX_TORQUE;
  const shoulder = new RevoluteJoint(
    {
      enableMotor: true,
      enableLimit: true,
      lowerAngle: -SHOULDER_LIMIT,
      upperAngle: SHOULDER_LIMIT,
      maxMotorTorque: maxTorque,
      motorSpeed: 0,
    },
    opts.body,
    upper,
    new Vec2(ax, ay),
  );
  world.createJoint(shoulder);
  const knee = new RevoluteJoint(
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
    new Vec2(ax, ay - opts.upperLen),
  );
  world.createJoint(knee);

  let active = true;
  function servo(joint: RevoluteJoint, target: number): number {
    const cur = joint.getJointAngle();
    const speed = Math.max(
      -LIMB_MAX_SPEED,
      Math.min(LIMB_MAX_SPEED, LIMB_GAIN * (target - cur)),
    );
    joint.setMotorSpeed(speed);
    return Math.abs(joint.getJointSpeed()) * maxTorque * FIXED_DT;
  }

  return {
    bodies: [upper, lower],
    drive(time, freq) {
      if (!active) return 0;
      return (
        servo(
          shoulder,
          opts.shoulderAmp * Math.sin(time * freq + opts.shoulderPhase),
        ) + servo(knee, opts.kneeAmp * Math.sin(time * freq + opts.kneePhase))
      );
    },
    disable() {
      active = false;
      shoulder.enableMotor(false);
      knee.enableMotor(false);
    },
    renderParts() {
      const up = upper.getPosition();
      const lo = lower.getPosition();
      return [
        {
          kind: "box",
          x: up.x,
          y: up.y,
          angle: upper.getAngle(),
          halfW: halfThick,
          halfH: upperHalf,
          role: "limb",
        },
        {
          kind: "box",
          x: lo.x,
          y: lo.y,
          angle: lower.getAngle(),
          halfW: halfThick,
          halfH: lowerHalf,
          role: "limb",
        },
      ];
    },
    jointPoints() {
      const sh = opts.body.getWorldPoint(opts.attachLocal);
      const kn = upper.getWorldPoint(new Vec2(0, -upperHalf));
      return [
        { x: sh.x, y: sh.y },
        { x: kn.x, y: kn.y },
      ];
    },
  };
}

// ---------------------------------------------------------------- wheel
export type WheelPart = {
  body: Body;
  energyThisStep(): number;
  disable(): void;
  renderPart(): RenderPart;
  center(): Pt;
};

export function buildWheel(
  world: World,
  opts: {
    chassis: Body;
    group: number;
    x: number;
    y: number;
    radius: number;
    torqueGene: number;
    suspFreq: number;
    suspDamp: number;
  },
): WheelPart {
  const wheel = world.createDynamicBody({ position: { x: opts.x, y: opts.y } });
  wheel.createFixture({
    shape: new Circle(opts.radius),
    density: DENSITY,
    friction: 0.95,
    filterGroupIndex: opts.group,
  });
  const maxTorque = opts.torqueGene * WHEEL_MOTOR_TORQUE_MAX;
  const joint = new WheelJoint(
    {
      enableMotor: opts.torqueGene > 0.02,
      motorSpeed: -WHEEL_MOTOR_SPEED, // negative spins the wheel to roll +x
      maxMotorTorque: maxTorque,
      frequencyHz: opts.suspFreq,
      dampingRatio: opts.suspDamp,
    },
    opts.chassis,
    wheel,
    wheel.getPosition(),
    new Vec2(0, 1),
  );
  world.createJoint(joint);

  let active = true;
  return {
    body: wheel,
    energyThisStep: () =>
      active ? Math.abs(wheel.getAngularVelocity()) * maxTorque * FIXED_DT : 0,
    disable() {
      active = false;
      joint.enableMotor(false);
    },
    renderPart() {
      const p = wheel.getPosition();
      return {
        kind: "circle",
        x: p.x,
        y: p.y,
        angle: wheel.getAngle(),
        r: opts.radius,
        role: "wheel",
      };
    },
    center() {
      const p = wheel.getPosition();
      return { x: p.x, y: p.y };
    },
  };
}

// ---------------------------------------------------------------- segment
// A single rigid segment on a revolute joint, either sine-servo driven (a tail)
// or free-spinning at a fixed motor speed (a flipper arm).
export type SegmentPart = {
  body: Body;
  drive(time: number, freq: number): number;
  disable(): void;
  renderPart(): RenderPart;
  jointPoint(): Pt;
};

export function buildSegment(
  world: World,
  opts: {
    body: Body;
    group: number;
    anchorLocal: Vec2;
    anchorWorld: Vec2;
    length: number;
    thickness: number;
    extendAngle: number; // direction the segment points at rest (radians from +x)
    torqueGene: number;
    role: RenderPart["role"];
    mode: "servo" | "spin";
    amp?: number; // servo
    phase?: number; // servo
    limit?: number; // servo, symmetric
    spinSpeed?: number; // spin
  },
): SegmentPart {
  const half = opts.length / 2;
  const halfThick = opts.thickness / 2;
  const dir = new Vec2(Math.cos(opts.extendAngle), Math.sin(opts.extendAngle));
  const cx = opts.anchorWorld.x + dir.x * half;
  const cy = opts.anchorWorld.y + dir.y * half;
  // box long axis is local +Y; rotate so it aligns with `dir`
  const bodyAngle = opts.extendAngle - Math.PI / 2;

  const seg = world.createDynamicBody({
    position: { x: cx, y: cy },
    angle: bodyAngle,
  });
  seg.createFixture({
    shape: new Box(halfThick, half),
    density: DENSITY,
    friction: 0.7,
    filterGroupIndex: opts.group,
  });

  const maxTorque = opts.torqueGene * LIMB_MAX_TORQUE;
  const useLimit = opts.mode === "servo";
  const limit = opts.limit ?? 1.2;
  const joint = new RevoluteJoint(
    {
      enableMotor: true,
      enableLimit: useLimit,
      lowerAngle: -limit,
      upperAngle: limit,
      maxMotorTorque: maxTorque,
      motorSpeed: opts.mode === "spin" ? (opts.spinSpeed ?? 8) : 0,
    },
    opts.body,
    seg,
    new Vec2(opts.anchorWorld.x, opts.anchorWorld.y),
  );
  world.createJoint(joint);

  let active = true;
  return {
    body: seg,
    drive(time, freq) {
      if (!active) return 0;
      if (opts.mode === "servo") {
        const target =
          (opts.amp ?? 0) * Math.sin(time * freq + (opts.phase ?? 0));
        const cur = joint.getJointAngle();
        const speed = Math.max(
          -SEG_MAX_SPEED,
          Math.min(SEG_MAX_SPEED, LIMB_GAIN * (target - cur)),
        );
        joint.setMotorSpeed(speed);
      }
      // spin mode holds its constant motorSpeed set at creation
      return Math.abs(joint.getJointSpeed()) * maxTorque * FIXED_DT;
    },
    disable() {
      active = false;
      joint.enableMotor(false);
    },
    renderPart() {
      const p = seg.getPosition();
      return {
        kind: "box",
        x: p.x,
        y: p.y,
        angle: seg.getAngle(),
        halfW: halfThick,
        halfH: half,
        role: opts.role,
      };
    },
    jointPoint() {
      const a = opts.body.getWorldPoint(opts.anchorLocal);
      return { x: a.x, y: a.y };
    },
  };
}
