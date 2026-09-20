// A deliberately tiny feed-forward network: inputs → one hidden layer → one
// output per thruster. All parameters live in one flat array so the GA can
// treat a brain as a plain vector of numbers.
//
// Layout of `params`:  W1 (hidden × inputs) | b1 (hidden) | W2 (outputs × hidden) | b2 (outputs)
//
// Outputs are clipped tanh, max(0, tanh(z)), not sigmoid. A sigmoid parks every
// random network at ~50% throttle, so generation 0 is a uniform lazy hover.
// Clipped tanh lets roughly half the random outputs sit fully off, which is
// where the chaos (and the diversity evolution feeds on) comes from.

import { gaussian, type Rng } from "./rng.ts";
import type { Activation, BrainLayout } from "./types.ts";

export function paramCount(l: BrainLayout): number {
  return l.hidden * l.inputs + l.hidden + l.outputs * l.hidden + l.outputs;
}

// Offsets into `params`, for the network view.
export function w1Index(l: BrainLayout, h: number, i: number): number {
  return h * l.inputs + i;
}
export function b1Index(l: BrainLayout, h: number): number {
  return l.hidden * l.inputs + h;
}
export function w2Index(l: BrainLayout, o: number, h: number): number {
  return l.hidden * l.inputs + l.hidden + o * l.hidden + h;
}
export function b2Index(l: BrainLayout, o: number): number {
  return l.hidden * l.inputs + l.hidden + l.outputs * l.hidden + o;
}

function activate(kind: Activation, z: number): number {
  switch (kind) {
    case "tanh":
      return Math.tanh(z);
    case "relu":
      return z > 0 ? z : 0;
    case "sigmoid":
      return 1 / (1 + Math.exp(-z));
  }
}

// One forward pass. Writes into the caller's buffers so a running episode
// allocates nothing per step (and the inspector can read them afterwards).
export function forward(
  l: BrainLayout,
  params: ArrayLike<number>,
  input: ArrayLike<number>,
  hidden: Float64Array,
  output: Float64Array,
): void {
  const { inputs: I, hidden: H, outputs: O } = l;
  const b1 = H * I;
  for (let h = 0; h < H; h++) {
    let z = params[b1 + h];
    const row = h * I;
    for (let i = 0; i < I; i++) z += params[row + i] * input[i];
    hidden[h] = activate(l.activation, z);
  }
  const w2 = b1 + H;
  const b2 = w2 + O * H;
  for (let o = 0; o < O; o++) {
    let z = params[b2 + o];
    const row = w2 + o * H;
    for (let h = 0; h < H; h++) z += params[row + h] * hidden[h];
    const t = Math.tanh(z);
    output[o] = t > 0 ? t : 0;
  }
}

// Random weights scaled by 1/√fan-in so every layer starts in the useful
// range of its activation, whatever the input count.
export function randomParams(l: BrainLayout, rng: Rng, gain = 1.5): number[] {
  const p = new Array<number>(paramCount(l));
  const s1 = gain / Math.sqrt(Math.max(1, l.inputs));
  const s2 = gain / Math.sqrt(Math.max(1, l.hidden));
  for (let h = 0; h < l.hidden; h++) {
    for (let i = 0; i < l.inputs; i++) p[w1Index(l, h, i)] = gaussian(rng) * s1;
    p[b1Index(l, h)] = gaussian(rng) * 0.5;
  }
  for (let o = 0; o < l.outputs; o++) {
    for (let h = 0; h < l.hidden; h++) p[w2Index(l, o, h)] = gaussian(rng) * s2;
    p[b2Index(l, o)] = gaussian(rng) * 0.5;
  }
  return p;
}
