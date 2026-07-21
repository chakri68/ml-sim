// The body plan: how a flat genome (Record<string, number>) becomes a concrete
// BodyGraph the interpreter can build. This is the seam where "evolve numbers"
// meets "evolve structure": `planGenes(legCount)` declares which genes exist for a
// crawler with N legs, and `buildCrawlerGraph` reads those numbers to emit the
// tree. Today legCount is a fixed choice; in M3 it becomes a mutable structural
// gene, and everything downstream (the interpreter, physics, view) is already
// agnostic to how many legs show up. No wheels — this concept is limbed creatures.
//
// Geometry convention (matches the interpreter's layout): a limb segment is a thin
// box whose long axis is local Y; it attaches at its TOP (jChild = (0, +halfH)) and
// hangs down. Legs spread along the body's underside, gaits phased so a walk can
// emerge instead of a symmetric flail.

import type { BodyGraph, GeneSpec, Genome, Part } from "./types.ts";

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;
const DENSITY = 1.0;

export const LEG_COUNTS = [2, 4, 6] as const;
export const DEFAULT_LEG_COUNT = 4;

// Structural bounds (§19.1 validation): a body must have at least one leg and no
// more than the interpreter/physics can comfortably chew. Structural mutation is
// clamped to this window.
export const MIN_LEGS = 1;
export const MAX_LEGS = 8;

// The five per-leg gene field suffixes, in order — the atom structural ops copy
// and reindex.
export const LEG_FIELDS = [
  "ShoulderAmp",
  "ShoulderPhase",
  "KneeAmp",
  "KneePhase",
  "Torque",
] as const;

// Shared (non-per-leg) gene specs.
const BASE_GENES: GeneSpec[] = [
  { key: "bodyWidth", group: "Body", label: "Body width", min: 1.0, max: 3.2, defaultValue: 1.9, unit: "m" },
  { key: "bodyHeight", group: "Body", label: "Body height", min: 0.3, max: 1.0, defaultValue: 0.5, unit: "m" },
  { key: "upperLen", group: "Body", label: "Upper limb length", min: 0.35, max: 1.4, defaultValue: 0.8, unit: "m" },
  { key: "lowerLen", group: "Body", label: "Lower limb length", min: 0.35, max: 1.4, defaultValue: 0.8, unit: "m" },
  { key: "thickness", group: "Body", label: "Limb thickness", min: 0.1, max: 0.3, defaultValue: 0.18, unit: "m" },
  { key: "gaitFreq", group: "Gait", label: "Gait tempo", min: 1.5, max: 7.0, defaultValue: 4, unit: "rad/s" },
];

function legGeneKeys(i: number): string[] {
  return [
    `leg${i}ShoulderAmp`,
    `leg${i}ShoulderPhase`,
    `leg${i}KneeAmp`,
    `leg${i}KneePhase`,
    `leg${i}Torque`,
  ];
}

// Per-leg motor genes. Default phase is staggered around the circle so an
// untrained body already breaks symmetry rather than hopping in place.
function legGenes(i: number, legCount: number): GeneSpec[] {
  const group = `Leg ${i + 1}`;
  const stagger = (i / legCount) * TWO_PI;
  return [
    { key: `leg${i}ShoulderAmp`, group, label: "Shoulder swing", min: 0, max: HALF_PI, defaultValue: HALF_PI * 0.5, display: "pi" },
    { key: `leg${i}ShoulderPhase`, group, label: "Shoulder phase", min: 0, max: TWO_PI, defaultValue: stagger, display: "pi" },
    { key: `leg${i}KneeAmp`, group, label: "Knee swing", min: 0, max: HALF_PI, defaultValue: HALF_PI * 0.5, display: "pi" },
    { key: `leg${i}KneePhase`, group, label: "Knee phase", min: 0, max: TWO_PI, defaultValue: Math.PI, display: "pi" },
    { key: `leg${i}Torque`, group, label: "Muscle strength", min: 0.2, max: 1.0, defaultValue: 0.6 },
  ];
}

export function planGenes(legCount: number): GeneSpec[] {
  const genes = [...BASE_GENES];
  for (let i = 0; i < legCount; i++) genes.push(...legGenes(i, legCount));
  return genes;
}

export function planGroups(legCount: number): string[] {
  const groups = ["Body", "Gait"];
  for (let i = 0; i < legCount; i++) groups.push(`Leg ${i + 1}`);
  return groups;
}

// Build a two-segment leg (upper limb + lower foot) hanging from the body at
// local underside point (hipX, -bodyHalfH). `g` is the genome's value bag.
function buildLeg(
  i: number,
  g: Record<string, number>,
  bodyHalfH: number,
  hipX: number,
): Part[] {
  const halfThick = g.thickness / 2;
  const upperHalf = g.upperLen / 2;
  const lowerHalf = g.lowerLen / 2;
  const torque = g[`leg${i}Torque`];
  const upper: Part = {
    id: `leg${i}-upper`,
    role: "limb",
    shape: { kind: "box", halfW: halfThick, halfH: upperHalf },
    density: DENSITY,
    friction: 0.9,
    attach: {
      parentId: "body",
      jParent: { x: hipX, y: -bodyHalfH },
      jChild: { x: 0, y: upperHalf },
      angle: 0,
      lowerAngle: -HALF_PI,
      upperAngle: HALF_PI,
      motor: {
        kind: "sine",
        amp: g[`leg${i}ShoulderAmp`],
        phase: g[`leg${i}ShoulderPhase`],
        freqMult: 1,
        speed: 0,
        torque,
      },
    },
  };
  const lower: Part = {
    id: `leg${i}-lower`,
    role: "foot",
    shape: { kind: "box", halfW: halfThick, halfH: lowerHalf },
    density: DENSITY,
    friction: 0.95,
    attach: {
      parentId: upper.id,
      jParent: { x: 0, y: -upperHalf },
      jChild: { x: 0, y: lowerHalf },
      angle: 0,
      lowerAngle: -2.0,
      upperAngle: 0.5,
      motor: {
        kind: "sine",
        amp: g[`leg${i}KneeAmp`],
        phase: g[`leg${i}KneePhase`],
        freqMult: 1,
        speed: 0,
        torque,
      },
    },
  };
  return [upper, lower];
}

export function buildCrawlerGraph(genome: Genome): BodyGraph {
  const g = genome.values;
  const legCount = genome.legCount;
  const bodyHalfW = g.bodyWidth / 2;
  const bodyHalfH = g.bodyHeight / 2;
  const body: Part = {
    id: "body",
    role: "body",
    shape: { kind: "box", halfW: bodyHalfW, halfH: bodyHalfH },
    density: DENSITY,
    friction: 0.6,
    attach: null,
  };
  const parts: Part[] = [body];
  for (let i = 0; i < legCount; i++) {
    const t = legCount === 1 ? 0 : i / (legCount - 1);
    const hipX = (t * 2 - 1) * 0.8 * bodyHalfW; // spread across the underside
    parts.push(...buildLeg(i, g, bodyHalfH, hipX));
  }
  return { rootId: "body", gaitFreq: g.gaitFreq, parts };
}

// Keys grouped by leg — the units of grouped crossover, so a whole leg's rhythm
// crosses over together rather than being shredded gene-by-gene.
export { legGeneKeys };
