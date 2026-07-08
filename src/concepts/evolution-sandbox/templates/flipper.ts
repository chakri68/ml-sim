// Flipper: a body with one big, continuously-spinning arm. The arm's angular
// momentum torques the whole body over — reward flipCount and it becomes a
// tumbling machine that cares about nothing else. The intentionally silly preset
// that makes the monkey's-paw lesson unforgettable: it does exactly what you
// rewarded, and exactly nothing you meant.

import { Box, Vec2, type World } from "planck";
import { createMetricsTracker, FIXED_DT } from "../physics.ts";
import { terrainHeight } from "../terrain.ts";
import { buildSegment, comOf, touching } from "./parts.ts";
import type {
  Genome,
  PhenotypeInstance,
  PhenotypeRenderState,
  Template,
  Terrain,
} from "../types.ts";

const GENES: Template["genes"] = [
  {
    key: "bodyWidth",
    group: "Body",
    label: "Body width",
    min: 0.6,
    max: 2.0,
    defaultValue: 1.0,
    unit: "m",
  },
  {
    key: "bodyHeight",
    group: "Body",
    label: "Body height",
    min: 0.3,
    max: 1.2,
    defaultValue: 0.6,
    unit: "m",
  },
  {
    key: "bodyDensity",
    group: "Body",
    label: "Body density",
    min: 0.5,
    max: 3.0,
    defaultValue: 1.0,
  },

  {
    key: "armLength",
    group: "Arm",
    label: "Arm length",
    min: 0.6,
    max: 2.2,
    defaultValue: 1.4,
    unit: "m",
  },
  {
    key: "armThickness",
    group: "Arm",
    label: "Arm thickness",
    min: 0.1,
    max: 0.4,
    defaultValue: 0.22,
    unit: "m",
  },
  {
    key: "armTorque",
    group: "Arm",
    label: "Motor torque",
    min: 0.3,
    max: 1.5,
    defaultValue: 1.0,
  },
  {
    key: "spinSpeed",
    group: "Arm",
    label: "Spin speed",
    min: 3,
    max: 14,
    defaultValue: 8,
    unit: "rad/s",
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

  const spawnX = 0;
  // elevate so the downward arm clears the ground and can start rotating
  const spawnY =
    terrainHeight(terrain, spawnX) + genome.armLength + halfH + 0.3;

  const body = world.createDynamicBody({ position: { x: spawnX, y: spawnY } });
  body.createFixture({
    shape: new Box(halfW, halfH),
    density: genome.bodyDensity,
    friction: 0.6,
    filterGroupIndex: groupIndex,
  });

  const arm = buildSegment(world, {
    body,
    group: groupIndex,
    anchorLocal: new Vec2(0, 0),
    anchorWorld: new Vec2(spawnX, spawnY),
    length: genome.armLength,
    thickness: genome.armThickness,
    extendAngle: -Math.PI / 2, // points straight down at rest
    torqueGene: genome.armTorque,
    role: "limb",
    mode: "spin",
    spinSpeed: genome.spinSpeed,
  });

  const tracker = createMetricsTracker(spawnX, spawnY);

  return {
    metrics: tracker.metrics,
    finished: false,
    bodyX: () => body.getPosition().x,
    update(time) {
      tracker.addEnergy(arm.drive(time, 1));

      let anyGround = touching(body);
      if (anyGround) tracker.addContact("body", FIXED_DT);
      if (touching(arm.body)) anyGround = true;

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
      arm.disable();
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
          arm.renderPart(),
        ],
        joints: [arm.jointPoint()],
        com: comOf([body, arm.body]),
      };
    },
  };
}

export const flipperTemplate: Template = {
  id: "flipper",
  label: "Flipper",
  subtitle:
    "A body with one big spinning arm. Rewards chaos — pair it with 'Do Flips'.",
  genes: GENES,
  geneGroups: ["Body", "Arm"],
  recommendedFitness: "do-flips",
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
    "stability",
    "instability",
  ],
  build,
};
