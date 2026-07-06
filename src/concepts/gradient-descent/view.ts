import type { FuncDef } from "./functions.ts";

export type Status =
  | "Idle"
  | "Running"
  | "Converging"
  | "Near minimum"
  | "Overshooting"
  | "Diverging";

// Snapshot the renderer needs each step. `pos`/`gradient` are vectors so the
// same shape covers 1D and 2D.
export type EngineState = {
  func: FuncDef;
  pos: number[];
  gradient: number[];
  trail: number[][];
  step: number;
  status: Status;
};

// Both the SVG (1D) and Three.js (3D) renderers implement this. The orchestrator
// only ever talks to a View, so switching modes is swap-one-object.
export type View = {
  el: HTMLElement;
  update(state: EngineState): void;
  dispose(): void;
};

export const MAX_TRAIL = 400;
