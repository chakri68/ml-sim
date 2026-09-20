// Planck adapter: one lander, one world, one episode. Each step runs the loop
// the whole concept is about (design §48):
//
//   sensors → normalize → network → throttles → forces → world.step → judge
//
// Every rover gets its OWN world. That costs a little memory but buys exact
// parity: the rover you watch in the live race and the same genome evaluated
// headlessly in the worker execute identical code on identical inputs, so a
// landing you see is the landing that gets scored. (A shared, collision-filtered
// world would couple rovers through broadphase ordering and drift apart.)
// Nothing above this file imports planck.

import { Chain, Polygon, Vec2, World } from "planck";
import { forward } from "./brain.ts";
import { gaussian, hashSeed, mulberry32 } from "./rng.ts";
import {
  buildGround,
  maxGroundBetween,
  raycastGround,
  type Ground,
} from "./terrain.ts";
import type {
  BrainLayout,
  Episode,
  EpisodeResult,
  FailureReason,
  Outcome,
  PlanetConfig,
  RoverDesign,
  Vec,
} from "./types.ts";

export const FIXED_DT = 1 / 60;
const VEL_ITERS = 8;
const POS_ITERS = 3;

// Landing criteria (design §49). Touchdown limits are checked at the first leg
// contact; the rest check decides whether it actually stayed down.
export const LANDING = {
  maxTouchdownVy: 2.5, // m/s
  maxTouchdownVx: 1.5, // m/s
  maxTilt: (12 * Math.PI) / 180,
  restSpeed: 0.35,
  restSpin: 0.35,
  restSeconds: 0.5,
};
const BOUNDS_X = 50; // m either side of the pad
const CEILING = 15; // m above the spawn height

// Normalization (design §51): continuous inputs go through tanh(v / scale), a
// soft clamp that stays sensitive near zero, where landing precision lives.
// With a linear v/20 the pad beacon reads 0.1 at 2 m off-target, too faint for
// small random weights to act on; tanh(2/8) reads 0.24.
const NORM = { vel: 4, tilt: 0.5, spin: 1, beaconX: 8, beaconY: 15 };
const soft = (v: number, scale: number) => Math.tanh(v / scale);

// A small reaction wheel bleeding off spin. Without it the population burns its
// whole budget learning not to tumble, and never gets to the landing itself;
// with it, tuned runs reach a champion that lands every training terrain.
const ATTITUDE_DAMPING = 1;

const HULL_DENSITY = 7;
const LEG_DENSITY = 2;
const LEG_THICKNESS = 0.1;

type Tag = "hull" | "leg-l" | "leg-r" | "ground";

export type RayState = { x1: number; y1: number; x2: number; y2: number; hit: boolean };

export type LanderRenderState = {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  spin: number;
  fuel: number; // 0..1
  throttle: number[]; // effective, 0 once the tank is dry
  rays: RayState[];
  legs: [boolean, boolean];
  outcome: Outcome | null;
  time: number;
};

export type LanderSim = {
  step(): void;
  done(): boolean;
  readonly time: number;
  result(): EpisodeResult;
  render(): LanderRenderState;
  // live network state, for the inspector / network view
  readonly input: Float64Array;
  readonly hidden: Float64Array;
  readonly output: Float64Array;
};

function wrapAngle(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export function channelCount(design: RoverDesign): number {
  let n = 0;
  for (const s of design.sensors)
    n += s.kind === "velocity" || s.kind === "beacon" ? 2 : 1;
  return n;
}

// Where the rover starts: above the pad by the episode's altitude, but always
// well clear of whatever hill sits under the spawn point.
export function spawnPoint(ground: Ground, episode: Episode): Vec {
  const x = ground.padX + episode.spawnDx;
  const y = Math.max(
    ground.padY + episode.spawnAltitude,
    maxGroundBetween(ground, x - 3, x + 3) + 7,
  );
  return { x, y };
}

function legPolygon(hip: Vec, foot: Vec): Vec2[] {
  const dx = foot.x - hip.x;
  const dy = foot.y - hip.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (LEG_THICKNESS / 2);
  const ny = (dx / len) * (LEG_THICKNESS / 2);
  return [
    new Vec2(hip.x + nx, hip.y + ny),
    new Vec2(foot.x + nx, foot.y + ny),
    new Vec2(foot.x - nx, foot.y - ny),
    new Vec2(hip.x - nx, hip.y - ny),
  ];
}

export function createLanderSim(opts: {
  design: RoverDesign;
  layout: BrainLayout;
  params: ArrayLike<number>;
  planet: PlanetConfig;
  episode: Episode;
  maxSeconds: number;
  ground?: Ground; // pass a prebuilt one when many rovers share an episode
}): LanderSim {
  const { design, layout, params, planet, episode, maxSeconds } = opts;
  const ground = opts.ground ?? buildGround(planet, episode);
  const spawn = spawnPoint(ground, episode);
  const padLeft = ground.padX - ground.padHalfWidth;
  const padRight = ground.padX + ground.padHalfWidth;
  const restHeight = -Math.min(design.legs.left.foot.y, design.legs.right.foot.y);

  const world = new World({ gravity: { x: 0, y: -planet.gravity }, allowSleep: false });
  const groundBody = world.createBody({ type: "static" });
  groundBody.createFixture({
    shape: new Chain(ground.points.map((p) => new Vec2(p.x, p.y))),
    friction: 0.9,
    userData: "ground" satisfies Tag,
  });

  const body = world.createBody({
    type: "dynamic",
    position: new Vec2(spawn.x, spawn.y),
    angle: episode.angle0,
    linearVelocity: new Vec2(episode.vx0, episode.vy0),
    linearDamping: planet.drag,
    angularDamping: ATTITUDE_DAMPING,
    allowSleep: false,
  });
  body.createFixture({
    shape: new Polygon(design.hull.map((v) => new Vec2(v.x, v.y))),
    density: HULL_DENSITY,
    friction: 0.6,
    userData: "hull" satisfies Tag,
  });
  body.createFixture({
    shape: new Polygon(legPolygon(design.legs.left.hip, design.legs.left.foot)),
    density: LEG_DENSITY,
    friction: 0.9,
    userData: "leg-l" satisfies Tag,
  });
  body.createFixture({
    shape: new Polygon(legPolygon(design.legs.right.hip, design.legs.right.foot)),
    density: LEG_DENSITY,
    friction: 0.9,
    userData: "leg-r" satisfies Tag,
  });
  const mass = body.getMass();

  const input = new Float64Array(layout.inputs);
  const hidden = new Float64Array(layout.hidden);
  const output = new Float64Array(layout.outputs);
  const throttle = new Array<number>(design.thrusters.length).fill(0);
  const rays: RayState[] = [];
  const noiseRng = mulberry32(hashSeed(episode.seed, 0x5e4));

  let time = 0;
  let fuel = design.fuelCapacity;
  let fuelOutAt = -1;
  let outcome: Outcome | null = null;
  let endSpeed = 0;
  let touchdown: { vx: number; vy: number } | null = null;
  let restTimer = 0;
  let maxAltitude = 0;
  let legs: [boolean, boolean] = [false, false];

  // ---- sense ---------------------------------------------------------------
  function sense() {
    const pos = body.getPosition();
    const vel = body.getLinearVelocity();
    const angle = body.getAngle();
    rays.length = 0;
    let k = 0;
    for (const s of design.sensors) {
      switch (s.kind) {
        case "range": {
          const o = body.getWorldPoint(new Vec2(s.x, s.y));
          const a = angle + s.angle;
          const dx = Math.cos(a);
          const dy = Math.sin(a);
          const d = raycastGround(ground, o.x, o.y, dx, dy, s.maxDistance);
          const hit = d !== Infinity;
          const len = hit ? d : s.maxDistance;
          rays.push({ x1: o.x, y1: o.y, x2: o.x + dx * len, y2: o.y + dy * len, hit });
          input[k++] = hit ? 1 - d / s.maxDistance : 0;
          break;
        }
        case "velocity":
          input[k++] = soft(vel.x, NORM.vel);
          input[k++] = soft(vel.y, NORM.vel);
          break;
        case "orientation":
          input[k++] = soft(wrapAngle(angle), NORM.tilt);
          break;
        case "angular-velocity":
          input[k++] = soft(body.getAngularVelocity(), NORM.spin);
          break;
        case "fuel":
          input[k++] = fuel / design.fuelCapacity;
          break;
        case "contact":
          input[k++] = legs[s.leg === "left" ? 0 : 1] ? 1 : 0;
          break;
        case "beacon":
          input[k++] = soft(ground.padX - pos.x, NORM.beaconX);
          input[k++] = soft(ground.padY - pos.y, NORM.beaconY);
          break;
      }
    }
    if (planet.sensorNoise > 0)
      for (let i = 0; i < k; i++) input[i] += gaussian(noiseRng) * planet.sensorNoise;
  }

  // ---- act -----------------------------------------------------------------
  function act() {
    const angle = body.getAngle();
    for (let t = 0; t < design.thrusters.length; t++) {
      const th = design.thrusters[t];
      const u = fuel > 0 ? output[t] : 0;
      throttle[t] = u;
      if (u <= 0) continue;
      const a = angle + th.angle;
      const f = th.maxForce * u;
      body.applyForce(
        new Vec2(Math.cos(a) * f, Math.sin(a) * f),
        body.getWorldPoint(new Vec2(th.x, th.y)),
        true,
      );
      fuel -= th.fuelRate * u * FIXED_DT;
    }
    if (fuel <= 0 && fuelOutAt < 0) {
      fuel = 0;
      fuelOutAt = time;
    }
    const w = planet.wind + planet.gust * Math.sin(0.5 * time + episode.windPhase);
    if (w !== 0) body.applyForceToCenter(new Vec2(mass * w, 0), true);
  }

  // ---- judge ---------------------------------------------------------------
  function touching(): { hull: boolean; l: boolean; r: boolean } {
    const c = { hull: false, l: false, r: false };
    for (let ce = body.getContactList(); ce; ce = ce.next) {
      const contact = ce.contact;
      if (!contact.isTouching()) continue;
      for (const f of [contact.getFixtureA(), contact.getFixtureB()]) {
        const tag = f.getUserData() as Tag;
        if (tag === "hull") c.hull = true;
        else if (tag === "leg-l") c.l = true;
        else if (tag === "leg-r") c.r = true;
      }
    }
    return c;
  }

  function crash(reason: FailureReason, speed: number) {
    // A crash after the tank ran dry is really a fuel failure.
    outcome = fuelOutAt >= 0 && reason !== "tip-over" ? "out-of-fuel" : reason;
    endSpeed = speed;
  }

  function judge(preVx: number, preVy: number) {
    const pos = body.getPosition();
    const tilt = wrapAngle(body.getAngle());
    const c = touching();
    legs = [c.l, c.r];
    maxAltitude = Math.max(maxAltitude, pos.y - ground.padY);
    const preSpeed = Math.hypot(preVx, preVy);

    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      outcome = "out-of-bounds";
      return;
    }
    if (c.hull) {
      if (touchdown) crash("tip-over", preSpeed);
      else if (Math.abs(tilt) > LANDING.maxTilt * 2) crash("excessive-tilt", preSpeed);
      else if (Math.abs(preVx) > LANDING.maxTouchdownVx && Math.abs(preVx) > -preVy)
        crash("excessive-horizontal-speed", preSpeed);
      else crash("hard-impact", preSpeed);
      return;
    }
    if (!touchdown && (c.l || c.r)) {
      touchdown = { vx: preVx, vy: preVy };
      if (-preVy > LANDING.maxTouchdownVy) return crash("hard-impact", preSpeed);
      if (Math.abs(preVx) > LANDING.maxTouchdownVx)
        return crash("excessive-horizontal-speed", preSpeed);
    }
    const v = body.getLinearVelocity();
    const resting =
      (c.l || c.r) &&
      Math.hypot(v.x, v.y) < LANDING.restSpeed &&
      Math.abs(body.getAngularVelocity()) < LANDING.restSpin;
    restTimer = resting ? restTimer + FIXED_DT : 0;
    if (restTimer >= LANDING.restSeconds) {
      const lf = body.getWorldPoint(new Vec2(design.legs.left.foot.x, design.legs.left.foot.y));
      const rf = body.getWorldPoint(new Vec2(design.legs.right.foot.x, design.legs.right.foot.y));
      const onPad =
        lf.x >= padLeft && lf.x <= padRight && rf.x >= padLeft && rf.x <= padRight;
      if (!onPad) outcome = "missed-zone";
      else if (Math.abs(tilt) > LANDING.maxTilt) outcome = "excessive-tilt";
      else outcome = "landed";
      endSpeed = Math.hypot(v.x, v.y);
      return;
    }
    if (Math.abs(pos.x - ground.padX) > BOUNDS_X || pos.y > spawn.y + CEILING) {
      outcome = "out-of-bounds";
      endSpeed = Math.hypot(v.x, v.y);
      return;
    }
    if (time >= maxSeconds - 1e-9) {
      outcome = "timeout";
      endSpeed = Math.hypot(v.x, v.y);
    }
  }

  sense(); // so the inspector has readings before the first step

  return {
    input,
    hidden,
    output,
    get time() {
      return time;
    },
    done: () => outcome !== null,
    step() {
      if (outcome) return;
      sense();
      forward(layout, params, input, hidden, output);
      act();
      const pv = body.getLinearVelocity();
      const preVx = pv.x;
      const preVy = pv.y;
      world.step(FIXED_DT, VEL_ITERS, POS_ITERS);
      time += FIXED_DT;
      judge(preVx, preVy);
    },
    result(): EpisodeResult {
      const pos = body.getPosition();
      const dx = Math.max(0, Math.abs(pos.x - ground.padX) - ground.padHalfWidth);
      const dy = Math.max(0, pos.y - restHeight - ground.padY);
      return {
        outcome: outcome ?? "timeout",
        time,
        fuelUsed: 1 - fuel / design.fuelCapacity,
        distance: Math.hypot(dx, dy),
        endSpeed,
        endTilt: Math.abs(wrapAngle(body.getAngle())),
        touchdown,
        maxAltitude,
        finalX: pos.x,
        finalY: pos.y,
      };
    },
    render(): LanderRenderState {
      const pos = body.getPosition();
      const vel = body.getLinearVelocity();
      return {
        x: pos.x,
        y: pos.y,
        angle: body.getAngle(),
        vx: vel.x,
        vy: vel.y,
        spin: body.getAngularVelocity(),
        fuel: fuel / design.fuelCapacity,
        throttle: throttle.slice(),
        rays: rays.slice(),
        legs: [legs[0], legs[1]],
        outcome,
        time,
      };
    },
  };
}
