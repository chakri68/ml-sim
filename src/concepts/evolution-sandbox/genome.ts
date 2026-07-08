// Generic genome operations, driven entirely by a template's GeneSpec[] and the
// user's per-gene range settings. Nothing here knows what a "wheel" or a "limb"
// is — it just samples, clamps, and clones numbers within the search window the
// user designed. This is what lets one engine breed any template.

import { clamp } from "../../lib/math.ts";
import type { Blueprint, GeneRangeSetting, Genome, Template } from "./types.ts";

// Build the default editable ranges for a template: start each gene's search
// window at the template's hard bounds, mutable, with a modest mutation strength.
export function defaultRanges(
  template: Template,
): Record<string, GeneRangeSetting> {
  const ranges: Record<string, GeneRangeSetting> = {};
  for (const g of template.genes) {
    ranges[g.key] = {
      min: g.min,
      max: g.max,
      mutable: true,
      mutationStrength: 0.1,
    };
  }
  return ranges;
}

export function makeBlueprint(template: Template): Blueprint {
  return { templateId: template.id, ranges: defaultRanges(template) };
}

// Sample one genome uniformly from the current search window. Immutable genes are
// pinned to their default value so they never drift.
export function createRandomGenome(
  template: Template,
  ranges: Record<string, GeneRangeSetting>,
): Genome {
  const genome: Genome = {};
  for (const g of template.genes) {
    const r = ranges[g.key];
    if (!r.mutable) {
      genome[g.key] = clamp(g.defaultValue, r.min, r.max);
    } else {
      genome[g.key] = r.min + Math.random() * (r.max - r.min);
    }
  }
  return genome;
}

export function createInitialPopulation(
  template: Template,
  ranges: Record<string, GeneRangeSetting>,
  size: number,
): Genome[] {
  return Array.from({ length: size }, () =>
    createRandomGenome(template, ranges),
  );
}

// Clamp every gene back inside its search window. Called after crossover/mutation
// so no genome outside the user's designed space ever reaches physics.
export function normalizeGenome(
  template: Template,
  genome: Genome,
  ranges: Record<string, GeneRangeSetting>,
): Genome {
  const out: Genome = {};
  for (const g of template.genes) {
    const r = ranges[g.key];
    out[g.key] = clamp(genome[g.key] ?? g.defaultValue, r.min, r.max);
  }
  return out;
}

export function cloneGenome(genome: Genome): Genome {
  return { ...genome };
}

// Standard normal via Box-Muller — small nudges common, big jumps rare.
export function randomGaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
