// Jumper: a body on two long, strong legs plus a tail, tuned to leave the
// ground. Same limb parts as the crawler but with longer/stronger ranges and a
// driven tail for airborne balance. Pairs naturally with the "Jump High" fitness
// preset — reward jumpHeight/airtime and watch it learn to launch.

import { Box, Vec2, type World } from "planck";
import { createMetricsTracker, FIXED_DT } from "../physics.ts";
import { terrainHeight } from "../terrain.ts";
import { buildLimb, buildSegment, comOf, DENSITY, touching } from "./parts.ts";
import type {
  Genome,
  PhenotypeInstance,
  PhenotypeRenderState,
  Template,
  Terrain,
} from "../types.ts";

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

const GENES: Template["genes"] = [
  {
    key: "bodyWidth",
    group: "Body",
    label: "Body width",
    min: 0.8,
    max: 2.2,
    defaultValue: 1.4,
    unit: "m",
  },
  {
    key: "bodyHeight",
    group: "Body",
    label: "Body height",
    min: 0.3,
    max: 0.9,
    defaultValue: 0.5,
    unit: "m",
  },

  {
    key: "limbAttach",
    group: "Legs",
    label: "Leg spread",
    min: 0.3,
    max: 0.95,
    defaultValue: 0.7,
  },
  {
    key: "upperLen",
    group: "Legs",
    label: "Upper length",
    min: 0.5,
    max: 1.8,
    defaultValue: 1.0,
    unit: "m",
  },
  {
    key: "lowerLen",
    group: "Legs",
    label: "Lower length",
    min: 0.5,
    max: 1.8,
    defaultValue: 1.0,
    unit: "m",
  },
  {
    key: "thickness",
    group: "Legs",
    label: "Thickness",
    min: 0.12,
    max: 0.32,
    defaultValue: 0.2,
    unit: "m",
  },
  {
    key: "gaitFrequency",
    group: "Legs",
    label: "Leg tempo",
    min: 1.0,
    max: 6.0,
    defaultValue: 3,
    unit: "rad/s",
  },

  {
    key: "frontShoulderAmp",
    group: "Front Leg",
    label: "Hip swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.6,
    display: "pi",
  },
  {
    key: "frontShoulderPhase",
    group: "Front Leg",
    label: "Hip phase",
    min: 0,
    max: TWO_PI,
    defaultValue: 0,
    display: "pi",
  },
  {
    key: "frontKneeAmp",
    group: "Front Leg",
    label: "Knee swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.6,
    display: "pi",
  },
  {
    key: "frontKneePhase",
    group: "Front Leg",
    label: "Knee phase",
    min: 0,
    max: TWO_PI,
    defaultValue: 0,
    display: "pi",
  },
  {
    key: "frontTorque",
    group: "Front Leg",
    label: "Muscle strength",
    min: 0.4,
    max: 1.5,
    defaultValue: 1.0,
  },

  {
    key: "rearShoulderAmp",
    group: "Rear Leg",
    label: "Hip swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.6,
    display: "pi",
  },
  {
    key: "rearShoulderPhase",
    group: "Rear Leg",
    label: "Hip phase",
    min: 0,
    max: TWO_PI,
    defaultValue: 0,
    display: "pi",
  },
  {
    key: "rearKneeAmp",
    group: "Rear Leg",
    label: "Knee swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.6,
    display: "pi",
  },
  {
    key: "rearKneePhase",
    group: "Rear Leg",
    label: "Knee phase",
    min: 0,
    max: TWO_PI,
    defaultValue: 0,
    display: "pi",
  },
  {
    key: "rearTorque",
    group: "Rear Leg",
    label: "Muscle strength",
    min: 0.4,
    max: 1.5,
    defaultValue: 1.0,
  },

  {
    key: "tailLength",
    group: "Tail",
    label: "Tail length",
    min: 0.2,
    max: 1.6,
    defaultValue: 0.7,
    unit: "m",
  },
  {
    key: "tailTorque",
    group: "Tail",
    label: "Tail strength",
    min: 0.2,
    max: 1.2,
    defaultValue: 0.6,
  },
  {
    key: "tailPhase",
    group: "Tail",
    label: "Tail phase",
    min: 0,
    max: TWO_PI,
    defaultValue: Math.PI,
    display: "pi",
  },
];

function build(params: {
  world: World;
  genome: Genome;
  terrain: Terrain;
  groupIndex: number;
}): PhenotypeInstance {
  const { world, genome, terrain, groupIndex } = params;
  const halfW = genome.bodyWidth / 2;
  const halfH = genome.bodyHeight / 2;
  const freq = genome.gaitFrequency;

  const spawnX = 0;
  const legReach = genome.upperLen + genome.lowerLen;
  const spawnY = terrainHeight(terrain, spawnX) + halfH + legReach + 0.06;

  const body = world.createDynamicBody({ position: { x: spawnX, y: spawnY } });
  body.createFixture({
    shape: new Box(halfW, halfH),
    density: DENSITY,
    friction: 0.6,
    filterGroupIndex: groupIndex,
  });

  const leg = (
    sign: number,
    torque: number,
    sAmp: number,
    sPhase: number,
    kAmp: number,
    kPhase: number,
  ) =>
    buildLimb(world, {
      body,
      group: groupIndex,
      attachLocal: new Vec2(sign * genome.limbAttach * halfW, -halfH),
      attachWorld: new Vec2(
        spawnX + sign * genome.limbAttach * halfW,
        spawnY - halfH,
      ),
      upperLen: genome.upperLen,
      lowerLen: genome.lowerLen,
      thickness: genome.thickness,
      torqueGene: torque,
      shoulderAmp: sAmp,
      shoulderPhase: sPhase,
      kneeAmp: kAmp,
      kneePhase: kPhase,
    });

  const front = leg(
    1,
    genome.frontTorque,
    genome.frontShoulderAmp,
    genome.frontShoulderPhase,
    genome.frontKneeAmp,
    genome.frontKneePhase,
  );
  const rear = leg(
    -1,
    genome.rearTorque,
    genome.rearShoulderAmp,
    genome.rearShoulderPhase,
    genome.rearKneeAmp,
    genome.rearKneePhase,
  );
  const legs = [front, rear];

  const tail = buildSegment(world, {
    body,
    group: groupIndex,
    anchorLocal: new Vec2(-halfW, 0),
    anchorWorld: new Vec2(spawnX - halfW, spawnY),
    length: genome.tailLength,
    thickness: genome.thickness * 0.9,
    extendAngle: Math.PI * 0.9, // points back and slightly down
    torqueGene: genome.tailTorque,
    role: "tail",
    mode: "servo",
    amp: 1.0,
    phase: genome.tailPhase,
    limit: 1.4,
  });

  const tracker = createMetricsTracker(spawnX, spawnY);

  return {
    metrics: tracker.metrics,
    finished: false,
    bodyX: () => body.getPosition().x,
    update(time) {
      let e = tail.drive(time, freq);
      for (const l of legs) e += l.drive(time, freq);
      tracker.addEnergy(e);

      let anyGround = touching(body);
      if (anyGround) tracker.addContact("body", FIXED_DT);
      for (const l of legs) {
        for (const b of l.bodies) {
          if (touching(b)) {
            anyGround = true;
            tracker.addContact("limb", FIXED_DT);
          }
        }
      }
      if (touching(tail.body)) anyGround = true;

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
      for (const l of legs) l.disable();
      tail.disable();
    },
    getRenderState(): PhenotypeRenderState {
      const bp = body.getPosition();
      return {
        parts: [
          {
            kind: "box",
            x: bp.x,
            y: bp.y,
            angle: body.getAngle(),
            halfW,
            halfH,
            role: "body",
          },
          ...front.renderParts(),
          ...rear.renderParts(),
          tail.renderPart(),
        ],
        joints: [
          ...front.jointPoints(),
          ...rear.jointPoints(),
          tail.jointPoint(),
        ],
        com: comOf([body, ...front.bodies, ...rear.bodies, tail.body]),
      };
    },
  };
}

export const jumperTemplate: Template = {
  id: "jumper",
  label: "Jumper",
  subtitle:
    "A body on two long, strong legs with a tail. Built to leave the ground.",
  genes: GENES,
  geneGroups: ["Body", "Legs", "Front Leg", "Rear Leg", "Tail"],
  recommendedFitness: "jump-high",
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
