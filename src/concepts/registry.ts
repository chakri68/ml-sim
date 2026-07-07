import type { Concept } from "./types.ts";
import { gradientDescent } from "./gradient-descent/index.ts";
import { geneticAlgorithms } from "./genetic-algorithms/index.ts";
import { evolvingVehicles } from "./evolving-vehicles/index.ts";

// The homepage maps over this list. Adding a concept is a data change here,
// not a refactor anywhere else.
export const concepts: Concept[] = [
  gradientDescent,
  geneticAlgorithms,
  evolvingVehicles,
];

export function findConcept(route: string): Concept | undefined {
  return concepts.find((c) => c.route === route);
}
