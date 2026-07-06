// Loss functions, unified across 1D (a curve) and 2D (a surface). Presets plus
// user-entered custom expressions parsed with mathjs (symbolic gradient, with a
// numeric central-difference fallback for anything mathjs can't differentiate).

import { derivative, parse } from "mathjs";

export type FuncDef = {
  id: string;
  label: string;
  expr: string; // human-readable / editable source
  dim: 1 | 2;
  fn: (v: number[]) => number;
  grad: (v: number[]) => number[];
  domain: [number, number][]; // per-axis [min, max]
  start: number[];
  minPoint?: number[]; // known global minimum, for the marker
  note: string;
  custom?: boolean;
};

// ---- presets ---------------------------------------------------------------

export const presets: FuncDef[] = [
  {
    id: "quadratic-shifted",
    label: "f(x) = (x − 3)² + 2",
    expr: "(x - 3)^2 + 2",
    dim: 1,
    fn: ([x]) => (x - 3) ** 2 + 2,
    grad: ([x]) => [2 * (x - 3)],
    domain: [[-6, 8]],
    start: [-5],
    minPoint: [3],
    note: "A clean bowl with a single minimum. The friendliest case.",
  },
  {
    id: "simple-bowl-1d",
    label: "f(x) = x²",
    expr: "x^2",
    dim: 1,
    fn: ([x]) => x ** 2,
    grad: ([x]) => [2 * x],
    domain: [[-6, 6]],
    start: [-5],
    minPoint: [0],
    note: "The textbook parabola, centred at the origin.",
  },
  {
    id: "double-well",
    label: "f(x) = 0.4·(x² − 4)²",
    expr: "0.4 * (x^2 - 4)^2",
    dim: 1,
    fn: ([x]) => 0.4 * (x ** 2 - 4) ** 2,
    grad: ([x]) => [1.6 * x * (x ** 2 - 4)],
    domain: [[-3.2, 3.2]],
    start: [-3],
    minPoint: [2],
    note: "Two valleys and a hill between them — descent can get stuck depending on where it starts.",
  },
  {
    id: "bowl-2d",
    label: "f(x,y) = x² + y²",
    expr: "x^2 + y^2",
    dim: 2,
    fn: ([x, y]) => x ** 2 + y ** 2,
    grad: ([x, y]) => [2 * x, 2 * y],
    domain: [
      [-5, 5],
      [-5, 5],
    ],
    start: [-4, 4],
    minPoint: [0, 0],
    note: "A round bowl. Every optimizer heads straight for the middle.",
  },
  {
    id: "ravine-2d",
    label: "f(x,y) = 0.18·x² + 3.2·y²",
    expr: "0.18 * x^2 + 3.2 * y^2",
    dim: 2,
    fn: ([x, y]) => 0.18 * x ** 2 + 3.2 * y ** 2,
    grad: ([x, y]) => [0.36 * x, 6.4 * y],
    domain: [
      [-6, 6],
      [-3, 3],
    ],
    start: [-5.5, 2.6],
    minPoint: [0, 0],
    note: "An ill-conditioned valley: steep across, shallow along. Plain GD zig-zags; RMSProp and Adam cut straight through. This is THE optimizer demo.",
  },
  {
    id: "rosenbrock",
    label: "f(x,y) = (1−x)² + 3·(y − x²)²",
    expr: "(1 - x)^2 + 3 * (y - x^2)^2",
    dim: 2,
    fn: ([x, y]) => (1 - x) ** 2 + 3 * (y - x ** 2) ** 2,
    grad: ([x, y]) => [-2 * (1 - x) - 12 * x * (y - x ** 2), 6 * (y - x ** 2)],
    domain: [
      [-2, 2],
      [-1, 3],
    ],
    start: [-1.6, 2.6],
    minPoint: [1, 1],
    note: "The banana valley. A curved trough that's easy to fall into but slow to follow — momentum and Adam earn their keep here.",
  },
];

export function findFunction(id: string): FuncDef {
  return presets.find((f) => f.id === id) ?? presets[0];
}

// ---- custom expressions ----------------------------------------------------

export type CompileResult =
  { ok: true; func: FuncDef } | { ok: false; error: string };

// Numeric central-difference gradient, used when symbolic differentiation fails.
function numericGrad(
  fn: (v: number[]) => number,
  dim: number,
): (v: number[]) => number[] {
  const h = 1e-4;
  return (v) => {
    const g = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      const up = v.slice();
      const down = v.slice();
      up[i] += h;
      down[i] -= h;
      g[i] = (fn(up) - fn(down)) / (2 * h);
    }
    return g;
  };
}

// Sample the domain to approximate the minimum, so custom functions still get a
// marker. Coarse but cheap; only used for display.
function approxMin(
  fn: (v: number[]) => number,
  domain: [number, number][],
): number[] {
  const dim = domain.length;
  const steps = dim === 1 ? 400 : 60;
  let best: number[] = domain.map(([lo, hi]) => (lo + hi) / 2);
  let bestVal = Infinity;
  const scan = (acc: number[], axis: number) => {
    if (axis === dim) {
      const val = fn(acc);
      if (Number.isFinite(val) && val < bestVal) {
        bestVal = val;
        best = acc.slice();
      }
      return;
    }
    const [lo, hi] = domain[axis];
    for (let i = 0; i <= steps; i++) {
      acc[axis] = lo + ((hi - lo) * i) / steps;
      scan(acc, axis + 1);
    }
  };
  scan(new Array(dim).fill(0), 0);
  return best;
}

export function compileCustom(raw: string): CompileResult {
  const expr = raw.trim();
  if (!expr) return { ok: false, error: "Enter an expression." };

  let node;
  try {
    node = parse(expr);
  } catch (e) {
    return { ok: false, error: `Couldn't parse: ${(e as Error).message}` };
  }

  // Collect variable symbols — but not function callees (mathjs models `sin` in
  // sin(x) as a SymbolNode) and not built-in constants like pi/e.
  const CONSTANTS = new Set([
    "e",
    "E",
    "pi",
    "PI",
    "tau",
    "phi",
    "Infinity",
    "NaN",
  ]);
  const symbols = new Set<string>();
  node.traverse((n, path, parent) => {
    if (n.type !== "SymbolNode") return;
    if (parent && parent.type === "FunctionNode" && path === "fn") return; // it's a function name
    symbols.add((n as unknown as { name: string }).name);
  });
  const usesY = symbols.has("y");
  const unknown = [...symbols].filter(
    (s) => s !== "x" && s !== "y" && !CONSTANTS.has(s),
  );
  if (unknown.length) {
    return {
      ok: false,
      error: `Only x and y are allowed (found: ${unknown.join(", ")}).`,
    };
  }
  const dim: 1 | 2 = usesY ? 2 : 1;

  let compiled;
  try {
    compiled = node.compile();
  } catch (e) {
    return { ok: false, error: `Couldn't compile: ${(e as Error).message}` };
  }

  const fn = (v: number[]): number => {
    const scope = dim === 2 ? { x: v[0], y: v[1] } : { x: v[0] };
    const out = compiled.evaluate(scope);
    return typeof out === "number" ? out : NaN;
  };

  // sanity-check evaluation before committing
  const probe = fn(dim === 2 ? [1, 1] : [1]);
  if (!Number.isFinite(probe)) {
    return {
      ok: false,
      error: "Expression didn't evaluate to a number at (1, 1).",
    };
  }

  // Try symbolic gradient; fall back to numeric if mathjs can't differentiate.
  let grad: (v: number[]) => number[];
  try {
    const dx = derivative(node, "x").compile();
    const dy = dim === 2 ? derivative(node, "y").compile() : null;
    grad = (v) => {
      const scope = dim === 2 ? { x: v[0], y: v[1] } : { x: v[0] };
      const gx = Number(dx.evaluate(scope));
      const gy = dy ? Number(dy.evaluate(scope)) : 0;
      return dim === 2 ? [gx, gy] : [gx];
    };
    // verify symbolic gradient is finite; else fall back
    if (!grad(dim === 2 ? [1, 1] : [1]).every(Number.isFinite)) {
      grad = numericGrad(fn, dim);
    }
  } catch {
    grad = numericGrad(fn, dim);
  }

  const domain: [number, number][] =
    dim === 2
      ? [
          [-5, 5],
          [-5, 5],
        ]
      : [[-6, 6]];

  const func: FuncDef = {
    id: "custom",
    label: `f(${dim === 2 ? "x,y" : "x"}) = ${expr}`,
    expr,
    dim,
    fn,
    grad,
    domain,
    start: dim === 2 ? [-4, 4] : [-5],
    minPoint: approxMin(fn, domain),
    note: "Your custom function. Gradient is computed symbolically where possible.",
    custom: true,
  };
  return { ok: true, func };
}
