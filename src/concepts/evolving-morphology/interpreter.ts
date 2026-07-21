// The interpreter — the heart of the concept. It turns a BodyGraph (pure data)
// into a live physics phenotype, generically, with no knowledge of "crawler" vs
// "rover". If this works, structural mutation is unlocked: anything the mutation
// operators can express as a tree of parts, this can build and simulate.
//
// Two passes:
//   1. LAYOUT (pure geometry). Walk the tree from the root, solving each part's
//      spawn center and angle from its parent's pose and its attachment. The joint
//      sits at one world point; given the child's absolute spawn angle we solve its
//      center from  R(angle)·jChild + center = jointWorld. Then lift the whole
//      assembly so its lowest point clears the terrain — a body that spawns clipped
//      into the ground explodes on frame one.
//   2. INSTANTIATE. Create a Planck body per part, a revolute joint per attachment
//      (sine servo / wheel motor / rigid weld), and wire up metrics.
//
// The root body's pose feeds the shared tracker; per-part ground contacts are
// bucketed by role (wheel/limb/body) so the contact-time metrics work.

import { Box, Circle, RevoluteJoint, Vec2, type World } from "planck";
import { createMetricsTracker, FIXED_DT } from "./physics.ts";
import { terrainHeight } from "./terrain.ts";
import type {
  BodyGraph,
  Part,
  PhenotypeInstance,
  PhenotypeRenderState,
  Terrain,
} from "./types.ts";

const MOTOR_GAIN = 9; // sine servo: angle-error -> motor-speed proportional gain
const MAX_MOTOR_SPEED = 9;
const MAX_MOTOR_TORQUE = 42; // a motor's torque gene (0..1) scales this
const SPAWN_X = 0;
const GROUND_CLEARANCE = 0.06; // metres above terrain the lowest part spawns

type Body = ReturnType<World["createDynamicBody"]>;

// Rotate a local vector by angle a.
function rot(v: { x: number; y: number }, a: number): Vec2 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

// How far a part's lowest point sits below its own center at spawn, used to size
// ground clearance. For a box rotated by `angle` the lowest corner is
// halfW·|sin| + halfH·|cos| below center; a wide flat chassis therefore only
// needs ~halfH of clearance, not its (much larger) diagonal — sizing off the
// diagonal would float the whole body and leave its wheels dangling.
function partLowestReach(part: Part, angle: number): number {
  if (part.shape.kind === "circle") return part.shape.r;
  return (
    part.shape.halfW * Math.abs(Math.sin(angle)) +
    part.shape.halfH * Math.abs(Math.cos(angle))
  );
}

type Placed = {
  part: Part;
  cx: number; // spawn center, world
  cy: number;
  angle: number; // spawn angle, world
};

// Pass 1: solve every part's spawn pose in a root-centred frame (root at origin).
function layout(graph: BodyGraph): Map<string, Placed> {
  const byId = new Map<string, Part>();
  for (const p of graph.parts) byId.set(p.id, p);

  const placed = new Map<string, Placed>();
  const root = byId.get(graph.rootId);
  if (!root) return placed;
  placed.set(root.id, { part: root, cx: 0, cy: 0, angle: 0 });

  // Children can only be placed after their parent, so resolve in dependency
  // order: repeatedly place any part whose parent is already placed. A tree
  // settles in at most `parts.length` sweeps; a part whose parent is missing
  // (malformed graph) is simply dropped rather than crashing the sim.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const part of graph.parts) {
      if (placed.has(part.id) || !part.attach) continue;
      const parent = placed.get(part.attach.parentId);
      if (!parent) continue;
      const a = part.attach;
      // joint world point = parent center + R(parentAngle)·jParent
      const jp = rot(a.jParent, parent.angle);
      const jointX = parent.cx + jp.x;
      const jointY = parent.cy + jp.y;
      // child center = jointWorld - R(childAngle)·jChild
      const jc = rot(a.jChild, a.angle);
      placed.set(part.id, {
        part,
        cx: jointX - jc.x,
        cy: jointY - jc.y,
        angle: a.angle,
      });
      progressed = true;
    }
  }
  return placed;
}

type BuiltPart = {
  placed: Placed;
  body: Body;
};

type JointDrive = {
  joint: RevoluteJoint;
  part: Part; // the child part (carries the motor spec)
  maxTorque: number;
};

export function buildPhenotype(
  graph: BodyGraph,
  world: World,
  terrain: Terrain,
  groupIndex: number,
): PhenotypeInstance {
  const placedMap = layout(graph);
  const placedList = [...placedMap.values()];

  // Lift the whole assembly so its lowest reach spawns just above the terrain at
  // SPAWN_X. Work in the root-centred frame first, then translate by (SPAWN_X, lift).
  let minY = Infinity;
  for (const p of placedList)
    minY = Math.min(minY, p.cy - partLowestReach(p.part, p.angle));
  const groundY = terrainHeight(terrain, SPAWN_X);
  const lift = groundY + GROUND_CLEARANCE - minY;

  const built = new Map<string, BuiltPart>();
  for (const p of placedList) {
    const body = world.createDynamicBody({
      position: { x: SPAWN_X + p.cx, y: p.cy + lift },
      angle: p.angle,
    });
    const shape =
      p.part.shape.kind === "box"
        ? new Box(p.part.shape.halfW, p.part.shape.halfH)
        : new Circle(p.part.shape.r);
    body.createFixture({
      shape,
      density: p.part.density,
      friction: p.part.friction,
      filterGroupIndex: groupIndex,
    });
    built.set(p.part.id, { placed: p, body });
  }

  // Joints, one per attached part.
  const drives: JointDrive[] = [];
  for (const bp of built.values()) {
    const a = bp.placed.part.attach;
    if (!a) continue;
    const parent = built.get(a.parentId);
    if (!parent) continue;
    // joint anchor in world = parent center + R(parentAngle)·jParent (post-lift)
    const parentPos = parent.body.getPosition();
    const jp = rot(a.jParent, parent.placed.angle);
    const anchor = new Vec2(parentPos.x + jp.x, parentPos.y + jp.y);
    const weld = a.motor.kind === "none";
    const wheel = a.motor.kind === "wheel";
    const maxTorque = a.motor.torque * MAX_MOTOR_TORQUE;
    const joint = new RevoluteJoint(
      {
        enableMotor: !weld,
        // wheels spin continuously (no angle limit); welds lock at [0,0]; sine
        // servos swing within their [lower, upper] window.
        enableLimit: !wheel,
        lowerAngle: weld ? 0 : a.lowerAngle,
        upperAngle: weld ? 0 : a.upperAngle,
        maxMotorTorque: maxTorque,
        motorSpeed: 0,
      },
      parent.body,
      bp.body,
      anchor,
    );
    world.createJoint(joint);
    if (!weld) drives.push({ joint, part: bp.placed.part, maxTorque });
  }

  const rootBuilt = built.get(graph.rootId);
  const rootBody = rootBuilt ? rootBuilt.body : null;
  const spawnX = rootBuilt ? rootBuilt.body.getPosition().x : SPAWN_X;
  const spawnY = rootBuilt ? rootBuilt.body.getPosition().y : groundY;
  const tracker = createMetricsTracker(spawnX, spawnY);
  let active = true;

  function touching(b: Body): boolean {
    for (let ce = b.getContactList(); ce; ce = ce.next)
      if (ce.contact.isTouching()) return true;
    return false;
  }

  function driveSine(d: JointDrive, time: number) {
    const m = d.part.attach!.motor;
    const target =
      m.amp * Math.sin(time * graph.gaitFreq * m.freqMult + m.phase);
    const current = d.joint.getJointAngle();
    const speed = Math.max(
      -MAX_MOTOR_SPEED,
      Math.min(MAX_MOTOR_SPEED, MOTOR_GAIN * (target - current)),
    );
    d.joint.setMotorSpeed(speed);
    tracker.addEnergy(Math.abs(d.joint.getJointSpeed()) * d.maxTorque * FIXED_DT);
  }

  function driveWheel(d: JointDrive) {
    const m = d.part.attach!.motor;
    d.joint.setMotorSpeed(m.speed);
    tracker.addEnergy(Math.abs(d.joint.getJointSpeed()) * d.maxTorque * FIXED_DT);
  }

  function contactBucket(role: Part["role"]): "body" | "wheel" | "limb" {
    if (role === "body") return "body";
    if (role === "wheel") return "wheel";
    return "limb"; // limb/foot/tail all count as limb contact
  }

  return {
    metrics: tracker.metrics,
    finished: false,
    bodyX: () => (rootBody ? rootBody.getPosition().x : SPAWN_X),
    update(time: number) {
      if (active) {
        for (const d of drives) {
          if (d.part.attach!.motor.kind === "wheel") driveWheel(d);
          else driveSine(d, time);
        }
      }
      let anyGround = false;
      for (const bp of built.values()) {
        if (touching(bp.body)) {
          anyGround = true;
          tracker.addContact(contactBucket(bp.placed.part.role), FIXED_DT);
        }
      }
      if (!rootBody) return;
      const pos = rootBody.getPosition();
      const vel = rootBody.getLinearVelocity();
      tracker.step({
        x: pos.x,
        y: pos.y,
        angle: rootBody.getAngle(),
        vx: vel.x,
        vy: vel.y,
        angVel: rootBody.getAngularVelocity(),
        anyOnGround: anyGround,
      });
    },
    done: () => tracker.aborted(),
    deactivate() {
      active = false;
      for (const d of drives) d.joint.enableMotor(false);
    },
    getRenderState(): PhenotypeRenderState {
      const parts: PhenotypeRenderState["parts"] = [];
      const joints: PhenotypeRenderState["joints"] = [];
      let mx = 0;
      let my = 0;
      let mtot = 0;
      for (const bp of built.values()) {
        const pos = bp.body.getPosition();
        const angle = bp.body.getAngle();
        const shape = bp.placed.part.shape;
        if (shape.kind === "box") {
          parts.push({
            kind: "box",
            x: pos.x,
            y: pos.y,
            angle,
            halfW: shape.halfW,
            halfH: shape.halfH,
            role: bp.placed.part.role,
          });
        } else {
          parts.push({
            kind: "circle",
            x: pos.x,
            y: pos.y,
            angle,
            r: shape.r,
            role: bp.placed.part.role,
          });
        }
        const m = bp.body.getMass();
        const c = bp.body.getWorldCenter();
        mx += c.x * m;
        my += c.y * m;
        mtot += m;
        // joint marker at this part's attachment anchor on its parent
        const a = bp.placed.part.attach;
        if (a) {
          const parent = built.get(a.parentId);
          if (parent) {
            const jw = parent.body.getWorldPoint(new Vec2(a.jParent.x, a.jParent.y));
            joints.push({ x: jw.x, y: jw.y });
          }
        }
      }
      return {
        parts,
        joints,
        com: { x: mtot ? mx / mtot : 0, y: mtot ? my / mtot : 0 },
      };
    },
  };
}
