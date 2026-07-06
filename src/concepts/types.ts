export type ConceptDifficulty = "beginner" | "intermediate" | "advanced";

// A mounted concept owns a DOM subtree and returns a cleanup fn the router
// calls on navigation (cancel animation frames, drop listeners, etc.).
export type MountFn = (root: HTMLElement) => () => void;

export type Concept = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  difficulty: ConceptDifficulty;
  tags: string[];
  route: string; // path segment after "#/concepts/"
  mount: MountFn;
  preview?: (root: SVGSVGElement) => void; // optional animated card art
};
