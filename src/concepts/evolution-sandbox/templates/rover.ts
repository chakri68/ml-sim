// Two-Wheel Rover: a chassis box on two motorized, suspended wheels. This is the
// template that exercises Planck's WheelJoint (a rotating motor plus a spring
// along a suspension axis) — the same primitive Evolving Vehicles used, here
// wrapped in the generic template interface so the sandbox engine can breed it.

import { Box, Circle, Vec2, WheelJoint, type World } from "planck";
import { lerp } from "../../../lib/math.ts";
import { createMetricsTracker, FIXED_DT } from "../physics.ts";
import { terrainHeight } from "../terrain.ts";
import type {
  Genome,
  PhenotypeInstance,
  PhenotypeRenderState,
  Template,
  Terrain,
} from "../types.ts";

const MOTOR_SPEED = 16; // rad/s the wheel motor drives toward
const MOTOR_TORQUE_MAX = 55; // torque gene (0..1) scales this
const SUS_FREQ = (stiff: number) => lerp(3, 8, stiff); // Hz
const DENSITY = 1.0;

const GENES: Template["genes"] = [
  {
    key: "chassisWidth",
    group: "Chassis",
    label: "Chassis width",
    min: 1.2,
    max: 3.4,
    defaultValue: 2.2,
    unit: "m",
  },
  {
    key: "chassisHeight",
    group: "Chassis",
    label: "Chassis height",
    min: 0.3,
    max: 1.0,
    defaultValue: 0.5,
    unit: "m",
  },
  {
    key: "frontWheelRadius",
    group: "Front Wheel",
    label: "Radius",
    min: 0.3,
    max: 1.1,
    defaultValue: 0.6,
    unit: "m",
  },
  {
    key: "frontWheelX",
    group: "Front Wheel",
    label: "Forward offset",
    min: 0.2,
    max: 0.95,
    defaultValue: 0.8,
  },
  {
    key: "frontMotorTorque",
    group: "Front Wheel",
    label: "Motor torque",
    min: 0,
    max: 1,
    defaultValue: 0.6,
  },
  {
    key: "rearWheelRadius",
    group: "Rear Wheel",
    label: "Radius",
    min: 0.3,
    max: 1.1,
    defaultValue: 0.6,
    unit: "m",
  },
  {
    key: "rearWheelX",
    group: "Rear Wheel",
    label: "Back offset",
    min: 0.2,
    max: 0.95,
    defaultValue: 0.8,
  },
  {
    key: "rearMotorTorque",
    group: "Rear Wheel",
    label: "Motor torque",
    min: 0,
    max: 1,
    defaultValue: 0.6,
  },
  {
    key: "suspensionStiffness",
    group: "Suspension",
    label: "Stiffness",
    min: 0,
    max: 1,
    defaultValue: 0.5,
  },
  {
    key: "suspensionDamping",
    group: "Suspension",
    label: "Damping",
    min: 0.1,
    max: 1,
    defaultValue: 0.6,
  },
];

function build(params: {
  world: World;
  genome: Genome;
  terrain: Terrain;
  groupIndex: number;
}): PhenotypeInstance {
  const { world, genome, terrain, groupIndex } = params;
  const halfW = genome.chassisWidth / 2;
  const halfH = genome.chassisHeight / 2;
  const maxR = Math.max(genome.frontWheelRadius, genome.rearWheelRadius);

  const spawnX = 0;
  const spawnY = terrainHeight(terrain, spawnX) + maxR + halfH + 0.4;

  const chassis = world.createDynamicBody({
    position: { x: spawnX, y: spawnY },
  });
  chassis.createFixture({
    shape: new Box(halfW, halfH),
    density: 1.1,
    friction: 0.3,
    filterGroupIndex: groupIndex,
  });

  function makeWheel(radius: number, offsetX: number, torqueGene: number) {
    const wx = spawnX + offsetX;
    const wy = spawnY - halfH - radius * 0.4;
    const wheel = world.createDynamicBody({ position: { x: wx, y: wy } });
    wheel.createFixture({
      shape: new Circle(radius),
      density: DENSITY,
      friction: 0.95,
      filterGroupIndex: groupIndex,
    });
    const maxTorque = torqueGene * MOTOR_TORQUE_MAX;
    const joint = new WheelJoint(
      {
        enableMotor: torqueGene > 0.02,
        motorSpeed: -MOTOR_SPEED, // negative spins the wheel to roll +x
        maxMotorTorque: maxTorque,
        frequencyHz: SUS_FREQ(genome.suspensionStiffness),
        dampingRatio: genome.suspensionDamping,
      },
      chassis,
      wheel,
      wheel.getPosition(),
      new Vec2(0, 1),
    );
    world.createJoint(joint);
    return { wheel, radius, joint, maxTorque };
  }

  const front = makeWheel(
    genome.frontWheelRadius,
    genome.frontWheelX * halfW,
    genome.frontMotorTorque,
  );
  const rear = makeWheel(
    genome.rearWheelRadius,
    -genome.rearWheelX * halfW,
    genome.rearMotorTorque,
  );
  const wheels = [front, rear];

  const tracker = createMetricsTracker(spawnX, spawnY);
  let active = true;

  function touching(body: ReturnType<World["createDynamicBody"]>): boolean {
    for (let ce = body.getContactList(); ce; ce = ce.next) {
      if (ce.contact.isTouching()) return true;
    }
    return false;
  }

  return {
    metrics: tracker.metrics,
    finished: false,
    bodyX: () => chassis.getPosition().x,
    update() {
      const pos = chassis.getPosition();
      const vel = chassis.getLinearVelocity();

      let anyGround = touching(chassis);
      if (anyGround) tracker.addContact("body", FIXED_DT);
      for (const w of wheels) {
        if (touching(w.wheel)) {
          anyGround = true;
          tracker.addContact("wheel", FIXED_DT);
        }
        if (active)
          tracker.addEnergy(
            Math.abs(w.wheel.getAngularVelocity()) * w.maxTorque * FIXED_DT,
          );
      }

      tracker.step({
        x: pos.x,
        y: pos.y,
        angle: chassis.getAngle(),
        vx: vel.x,
        vy: vel.y,
        angVel: chassis.getAngularVelocity(),
        anyOnGround: anyGround,
      });
    },
    done: () => tracker.aborted(),
    deactivate() {
      active = false;
      for (const w of wheels) w.joint.enableMotor(false);
    },
    getRenderState(): PhenotypeRenderState {
      const cp = chassis.getPosition();
      let mx = 0;
      let my = 0;
      let mtot = 0;
      for (const b of [chassis, front.wheel, rear.wheel]) {
        const m = b.getMass();
        const c = b.getWorldCenter();
        mx += c.x * m;
        my += c.y * m;
        mtot += m;
      }
      return {
        parts: [
          {
            kind: "box",
            x: cp.x,
            y: cp.y,
            angle: chassis.getAngle(),
            halfW,
            halfH,
            role: "body",
          },
          ...wheels.map((w) => {
            const p = w.wheel.getPosition();
            return {
              kind: "circle" as const,
              x: p.x,
              y: p.y,
              angle: w.wheel.getAngle(),
              r: w.radius,
              role: "wheel" as const,
            };
          }),
        ],
        joints: wheels.map((w) => {
          const p = w.wheel.getPosition();
          return { x: p.x, y: p.y };
        }),
        com: { x: mx / mtot, y: my / mtot },
      };
    },
  };
}

export const roverTemplate: Template = {
  id: "two-wheel-rover",
  label: "Two-Wheel Rover",
  subtitle:
    "A chassis on two motorized, suspended wheels. Great for distance, speed, and hills.",
  genes: GENES,
  geneGroups: ["Chassis", "Front Wheel", "Rear Wheel", "Suspension"],
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
    "wheelGroundContactTime",
    "stability",
    "instability",
  ],
  build,
};
