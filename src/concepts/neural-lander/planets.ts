// Planet presets: gravity, atmosphere, wind, terrain and sensor quality. The
// Balanced lander's main engine is sized for the Moon and Mars; on Earth it
// can't lift its own weight, which is the point of including it.

import type { PlanetConfig } from "./types.ts";

export const PLANETS: PlanetConfig[] = [
  {
    id: "moon",
    label: "Moon",
    blurb: "1.62 m/s², no air, no wind. Cratered hills, clean sensors, a generous pad. The classroom.",
    gravity: 1.62,
    drag: 0,
    wind: 0,
    gust: 0,
    roughness: 5,
    padHalfWidth: 4,
    sensorNoise: 0,
    spawnSpread: 8,
  },
  {
    id: "mars",
    label: "Mars",
    blurb: "3.71 m/s², thin air, a steady breeze with gusts, slightly noisy sensors.",
    gravity: 3.71,
    drag: 0.05,
    wind: 0.3,
    gust: 0.25,
    roughness: 4,
    padHalfWidth: 4,
    sensorNoise: 0.02,
    spawnSpread: 8,
  },
  {
    id: "earth",
    label: "Earth",
    blurb:
      "9.81 m/s² and thick air. The stock engines can't hover here: no brain fixes a thrust-to-weight ratio under 1.",
    gravity: 9.81,
    drag: 0.15,
    wind: 0.2,
    gust: 0.2,
    roughness: 3,
    padHalfWidth: 3.5,
    sensorNoise: 0.01,
    spawnSpread: 10,
  },
  {
    id: "chaos",
    label: "Chaos",
    blurb:
      "Strong gusty wind, jagged ground, a narrow pad, noisy sensors and wide spawns. A test, not a classroom.",
    gravity: 2.5,
    drag: 0.02,
    wind: 0.5,
    gust: 0.6,
    roughness: 8,
    padHalfWidth: 1.5,
    sensorNoise: 0.08,
    spawnSpread: 20,
  },
];

export const DEFAULT_PLANET_ID = "moon";

export function findPlanet(id: string): PlanetConfig {
  return PLANETS.find((p) => p.id === id) ?? PLANETS[0];
}
