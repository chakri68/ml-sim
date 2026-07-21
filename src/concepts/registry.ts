import type { Concept } from "./types.ts";
import { gradientDescent } from "./gradient-descent/index.ts";
import { geneticAlgorithms } from "./genetic-algorithms/index.ts";
import { evolvingVehicles } from "./evolving-vehicles/index.ts";
import { evolvingCreatures } from "./evolving-creatures/index.ts";
import { evolutionSandbox } from "./evolution-sandbox/index.ts";
import { evolvingMorphology } from "./evolving-morphology/index.ts";

// The homepage maps over this list. Adding a concept is a data change here,
// not a refactor anywhere else.
export const concepts: Concept[] = [
  gradientDescent,
  geneticAlgorithms,
  evolvingVehicles,
  evolvingCreatures,
  evolutionSandbox,
  evolvingMorphology,
];

export function findConcept(route: string): Concept | undefined {
  return concepts.find((c) => c.route === route);
}
