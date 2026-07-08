// Wheel-Creature Hybrid: a body with a jointed front limb (a leg that paddles)
// and a motorized rear wheel (that rolls). The most "cursed robotics" preset —
// two locomotion styles fighting for the same body. Assembled from the shared
// limb + wheel parts.

import { Box, Vec2, type World } from "planck";
import { lerp } from "../../../lib/math.ts";
import { createMetricsTracker, FIXED_DT } from "../physics.ts";
import { terrainHeight } from "../terrain.ts";
import { buildLimb, buildWheel, comOf, DENSITY, touching } from "./parts.ts";
import type {
  Genome,
  PhenotypeInstance,
  PhenotypeRenderState,
  Template,
  Terrain,
} from "../types.ts";

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;
const SUS_FREQ = (stiff: number) => lerp(3, 8, stiff);

const GENES: Template["genes"] = [
  {
    key: "bodyWidth",
    group: "Body",
    label: "Body width",
    min: 1.2,
    max: 3.0,
    defaultValue: 2.0,
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
    group: "Front Limb",
    label: "Limb position",
    min: 0.2,
    max: 0.9,
    defaultValue: 0.6,
  },
  {
    key: "upperLen",
    group: "Front Limb",
    label: "Upper length",
    min: 0.3,
    max: 1.0,
    defaultValue: 0.6,
    unit: "m",
  },
  {
    key: "lowerLen",
    group: "Front Limb",
    label: "Lower length",
    min: 0.3,
    max: 1.0,
    defaultValue: 0.6,
    unit: "m",
  },
  {
    key: "thickness",
    group: "Front Limb",
    label: "Thickness",
    min: 0.1,
    max: 0.28,
    defaultValue: 0.16,
    unit: "m",
  },

  {
    key: "gaitFrequency",
    group: "Front Motors",
    label: "Gait tempo",
    min: 1.5,
    max: 7.0,
    defaultValue: 4,
    unit: "rad/s",
  },
  {
    key: "shoulderAmp",
    group: "Front Motors",
    label: "Shoulder swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.5,
    display: "pi",
  },
  {
    key: "shoulderPhase",
    group: "Front Motors",
    label: "Shoulder phase",
    min: 0,
    max: TWO_PI,
    defaultValue: 0,
    display: "pi",
  },
  {
    key: "kneeAmp",
    group: "Front Motors",
    label: "Knee swing",
    min: 0,
    max: HALF_PI,
    defaultValue: HALF_PI * 0.5,
    display: "pi",
  },
  {
    key: "kneePhase",
    group: "Front Motors",
    label: "Knee phase",
    min: 0,
    max: TWO_PI,
    defaultValue: Math.PI,
    display: "pi",
  },
  {
    key: "limbTorque",
    group: "Front Motors",
    label: "Muscle strength",
    min: 0.2,
    max: 1.0,
    defaultValue: 0.6,
  },

  {
    key: "wheelRadius",
    group: "Rear Wheel",
    label: "Radius",
    min: 0.3,
    max: 1.0,
    defaultValue: 0.6,
    unit: "m",
  },
  {
    key: "wheelX",
    group: "Rear Wheel",
    label: "Back offset",
    min: 0.2,
    max: 0.95,
    defaultValue: 0.8,
  },
  {
    key: "wheelTorque",
    group: "Rear Wheel",
    label: "Motor torque",
    min: 0,
    max: 1,
    defaultValue: 0.6,
  },
  {
    key: "suspensionStiffness",
    group: "Rear Wheel",
    label: "Suspension stiffness",
    min: 0,
    max: 1,
    defaultValue: 0.5,
  },
  {
    key: "suspensionDamping",
    group: "Rear Wheel",
    label: "Suspension damping",
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
  const halfW = genome.bodyWidth / 2;
  const halfH = genome.bodyHeight / 2;
  const r = genome.wheelRadius;
  const freq = genome.gaitFrequency;

  const spawnX = 0;
  // Spawn high enough that BOTH the hanging front leg and the rear wheel clear
  // the ground — whichever reaches lower below the body. Using only the wheel
  // radius (as the rover does) lets a long leg spawn *into* the terrain, where it
  // snags on the ground edges and the machine gets stuck. It settles under
  // gravity onto leg + wheel from here. (Leg foot is `legReach` below the body's
  // underside; the wheel's lowest point is r*0.4 + r = 1.4r below it.)
  const legReach = genome.upperLen + genome.lowerLen;
  const spawnY =
    terrainHeight(terrain, spawnX) + halfH + Math.max(legReach, r * 1.4) + 0.15;

  const body = world.createDynamicBody({ position: { x: spawnX, y: spawnY } });
  body.createFixture({
    shape: new Box(halfW, halfH),
    density: DENSITY,
    friction: 0.5,
    filterGroupIndex: groupIndex,
  });

  const limb = buildLimb(world, {
    body,
    group: groupIndex,
    attachLocal: new Vec2(genome.limbAttach * halfW, -halfH),
    attachWorld: new Vec2(spawnX + genome.limbAttach * halfW, spawnY - halfH),
    upperLen: genome.upperLen,
    lowerLen: genome.lowerLen,
    thickness: genome.thickness,
    torqueGene: genome.limbTorque,
    shoulderAmp: genome.shoulderAmp,
    shoulderPhase: genome.shoulderPhase,
    kneeAmp: genome.kneeAmp,
    kneePhase: genome.kneePhase,
  });

  const wheel = buildWheel(world, {
    chassis: body,
    group: groupIndex,
    x: spawnX - genome.wheelX * halfW,
    y: spawnY - halfH - r * 0.4,
    radius: r,
    torqueGene: genome.wheelTorque,
    suspFreq: SUS_FREQ(genome.suspensionStiffness),
    suspDamp: genome.suspensionDamping,
  });

  const tracker = createMetricsTracker(spawnX, spawnY);

  return {
    metrics: tracker.metrics,
    finished: false,
    bodyX: () => body.getPosition().x,
    update(time) {
      tracker.addEnergy(limb.drive(time, freq) + wheel.energyThisStep());

      let anyGround = touching(body);
      if (anyGround) tracker.addContact("body", FIXED_DT);
      for (const b of limb.bodies) {
        if (touching(b)) {
          anyGround = true;
          tracker.addContact("limb", FIXED_DT);
        }
      }
      if (touching(wheel.body)) {
        anyGround = true;
        tracker.addContact("wheel", FIXED_DT);
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
      limb.disable();
      wheel.disable();
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
          ...limb.renderParts(),
          wheel.renderPart(),
        ],
        joints: [...limb.jointPoints(), wheel.center()],
        com: comOf([body, ...limb.bodies, wheel.body]),
      };
    },
  };
}

export const hybridTemplate: Template = {
  id: "wheel-creature-hybrid",
  label: "Wheel-Creature Hybrid",
  subtitle:
    "A jointed front leg and a motorized rear wheel. Cursed hybrid locomotion.",
  genes: GENES,
  geneGroups: ["Body", "Front Limb", "Front Motors", "Rear Wheel"],
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
    "limbGroundContactTime",
    "stability",
    "instability",
  ],
  build,
};
