// Rover presets and the observation layout derived from them. A design is pure
// data: hull, legs, where each sensor and thruster is bolted on. The network's
// input and output counts fall out of that, so swapping a design (or switching a
// sensor off) reshapes the brain.

import type { RoverDesign, SensorSpec, ThrusterSpec } from "./types.ts";

const DOWN = -Math.PI / 2;

const HULL = [
  { x: -0.8, y: -0.5 },
  { x: 0.8, y: -0.5 },
  { x: 0.55, y: 0.5 },
  { x: -0.55, y: 0.5 },
];
const LEGS = {
  left: { hip: { x: -0.6, y: -0.45 }, foot: { x: -1.15, y: -1.25 } },
  right: { hip: { x: 0.6, y: -0.45 }, foot: { x: 1.15, y: -1.25 } },
};

const range = (
  id: string,
  label: string,
  x: number,
  angle: number,
): SensorSpec => ({
  id,
  kind: "range",
  label,
  x,
  y: -0.5,
  angle,
  maxDistance: 30,
});

const MAIN: ThrusterSpec = {
  id: "main",
  label: "Main",
  x: 0,
  y: -0.5,
  angle: Math.PI / 2,
  maxForce: 65,
  fuelRate: 6,
};
// Side thrusters sit high on the hull and push sideways, so each one both
// shoves the rover and twists it: left pushes right and rolls it clockwise.
const RCS_LEFT: ThrusterSpec = {
  id: "rcs-left",
  label: "Left RCS",
  x: -0.62,
  y: 0.35,
  angle: 0,
  maxForce: 10,
  fuelRate: 1.5,
};
const RCS_RIGHT: ThrusterSpec = {
  id: "rcs-right",
  label: "Right RCS",
  x: 0.62,
  y: 0.35,
  angle: Math.PI,
  maxForce: 10,
  fuelRate: 1.5,
};

const CORE_SENSORS: SensorSpec[] = [
  { id: "vel", kind: "velocity", label: "Velocity" },
  { id: "tilt", kind: "orientation", label: "Orientation" },
  { id: "spin", kind: "angular-velocity", label: "Angular velocity" },
  { id: "beacon", kind: "beacon", label: "Pad beacon" },
  { id: "leg-l", kind: "contact", label: "Left leg contact", leg: "left" },
  { id: "leg-r", kind: "contact", label: "Right leg contact", leg: "right" },
];

export const DESIGNS: RoverDesign[] = [
  {
    id: "balanced",
    label: "Balanced Lander",
    blurb:
      "Three down-facing rays, velocity, orientation, spin, a pad beacon and leg contacts. One main engine, two side thrusters.",
    hull: HULL,
    legs: LEGS,
    sensors: [
      range("ray-l", "Ray ↙", -0.4, DOWN - 0.6),
      range("ray-c", "Ray ↓", 0, DOWN),
      range("ray-r", "Ray ↘", 0.4, DOWN + 0.6),
      ...CORE_SENSORS,
    ],
    thrusters: [MAIN, RCS_LEFT, RCS_RIGHT],
    fuelCapacity: 100,
  },
  {
    id: "minimal",
    label: "Minimal Lander",
    blurb:
      "One downward ray, orientation and the pad beacon. Two angled engines: fire both to climb, fire one to turn. No velocity sense at all.",
    hull: HULL,
    legs: LEGS,
    sensors: [
      range("ray-c", "Ray ↓", 0, DOWN),
      { id: "tilt", kind: "orientation", label: "Orientation" },
      { id: "beacon", kind: "beacon", label: "Pad beacon" },
    ],
    thrusters: [
      {
        id: "eng-l",
        label: "Left engine",
        x: -0.5,
        y: -0.5,
        angle: Math.PI / 2 - 0.2,
        maxForce: 38,
        fuelRate: 3.5,
      },
      {
        id: "eng-r",
        label: "Right engine",
        x: 0.5,
        y: -0.5,
        angle: Math.PI / 2 + 0.2,
        maxForce: 38,
        fuelRate: 3.5,
      },
    ],
    fuelCapacity: 100,
  },
  {
    id: "over-sensored",
    label: "Over-Sensored",
    blurb:
      "Eight rays fanned under the hull plus every other sensor. More inputs, more weights, a bigger search space for evolution.",
    hull: HULL,
    legs: LEGS,
    sensors: [
      ...Array.from({ length: 8 }, (_, i) => {
        const a = DOWN - 1.3 + (i * 2.6) / 7;
        return range(`ray-${i}`, `Ray ${i + 1}`, -0.6 + (i * 1.2) / 7, a);
      }),
      ...CORE_SENSORS,
      { id: "fuel", kind: "fuel", label: "Fuel gauge" },
    ],
    thrusters: [MAIN, RCS_LEFT, RCS_RIGHT],
    fuelCapacity: 100,
  },
  {
    id: "bad",
    label: "Bad Design",
    blurb:
      "Same sensors as Balanced, but the main engine is bolted off-centre and there's only one side thruster. Every burn spins it.",
    hull: HULL,
    legs: LEGS,
    sensors: [
      range("ray-l", "Ray ↙", -0.4, DOWN - 0.6),
      range("ray-c", "Ray ↓", 0, DOWN),
      range("ray-r", "Ray ↘", 0.4, DOWN + 0.6),
      ...CORE_SENSORS,
    ],
    thrusters: [
      { ...MAIN, x: 0.55, angle: Math.PI / 2 + 0.25 },
      RCS_LEFT,
    ],
    fuelCapacity: 100,
  },
];

export const DEFAULT_DESIGN_ID = "balanced";

export function findDesign(id: string): RoverDesign {
  return DESIGNS.find((d) => d.id === id) ?? DESIGNS[0];
}

// A design with some sensors switched off. Order is preserved so input
// neurons keep a stable reading order.
export function withSensors(design: RoverDesign, enabled: Set<string>): RoverDesign {
  return { ...design, sensors: design.sensors.filter((s) => enabled.has(s.id)) };
}

// How many input neurons each sensor kind feeds, and their labels.
export function sensorChannels(s: SensorSpec): string[] {
  switch (s.kind) {
    case "range":
      return [s.label];
    case "velocity":
      return ["Vel x", "Vel y"];
    case "orientation":
      return ["Tilt"];
    case "angular-velocity":
      return ["Spin"];
    case "fuel":
      return ["Fuel"];
    case "contact":
      return [s.leg === "left" ? "Leg L" : "Leg R"];
    case "beacon":
      return ["Pad dx", "Pad dy"];
  }
}

export function inputLabels(design: RoverDesign): string[] {
  return design.sensors.flatMap(sensorChannels);
}

export function outputLabels(design: RoverDesign): string[] {
  return design.thrusters.map((t) => t.label);
}
