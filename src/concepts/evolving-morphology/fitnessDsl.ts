// A tiny, SAFE arithmetic language for fitness expressions — ported from the
// Evolution Sandbox. This is the concept's teaching soul: "evolution optimizes
// what you reward, not what you meant." Users write their own scoring formula, and
// with structural mutation live, the reward literally reshapes the body — reward
// distance and it grows legs; reward distance-per-energy and it drops them.
//
// It must NOT be JavaScript: no eval, no Function constructor, no property access,
// no globals. We tokenize, parse into a small AST, and evaluate that AST against a
// fixed FitnessMetrics record. The only things an expression can do are read a
// known metric, use + - * /, group with parentheses, and call min/max/abs/clamp.
// Anything else fails to parse — the dangerous forms simply have no grammar.

import {
  isMetricName,
  type FitnessMetrics,
  type MetricName,
} from "./metrics.ts";
import type { FitnessBreakdownItem } from "./types.ts";

const MAX_LENGTH = 300;
const MAX_DEPTH = 20;

const FUNCTIONS = {
  min: { arity: 2 },
  max: { arity: 2 },
  abs: { arity: 1 },
  clamp: { arity: 3 },
} as const;
type FnName = keyof typeof FUNCTIONS;

export type FitnessNode =
  | { type: "number"; value: number }
  | { type: "metric"; name: MetricName }
  | { type: "unary"; op: "-"; operand: FitnessNode }
  | {
      type: "binary";
      op: "+" | "-" | "*" | "/";
      left: FitnessNode;
      right: FitnessNode;
    }
  | { type: "call"; fn: FnName; args: FitnessNode[] };

export class FitnessSyntaxError extends Error {}

type Token =
  | { kind: "num"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen" });
      i++;
    } else if (c === ")") {
      tokens.push({ kind: "rparen" });
      i++;
    } else if (c === ",") {
      tokens.push({ kind: "comma" });
      i++;
    } else if (c === "+" || c === "-" || c === "*" || c === "/") {
      tokens.push({ kind: "op", value: c });
      i++;
    } else if (c >= "0" && c <= "9") {
      let j = i + 1;
      let seenDot = false;
      while (
        j < src.length &&
        ((src[j] >= "0" && src[j] <= "9") || (src[j] === "." && !seenDot))
      ) {
        if (src[j] === ".") seenDot = true;
        j++;
      }
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num))
        throw new FitnessSyntaxError(`Bad number near "${src.slice(i, j)}"`);
      tokens.push({ kind: "num", value: num });
      i = j;
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: "ident", value: src.slice(i, j) });
      i = j;
    } else {
      throw new FitnessSyntaxError(`Unexpected character "${c}"`);
    }
  }
  return tokens;
}

function parse(src: string): FitnessNode {
  if (src.length > MAX_LENGTH) {
    throw new FitnessSyntaxError(
      `Expression too long (max ${MAX_LENGTH} characters).`,
    );
  }
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(depth: number): FitnessNode {
    if (depth > MAX_DEPTH)
      throw new FitnessSyntaxError("Expression nests too deeply.");
    let left = parseTerm(depth);
    while (
      peek()?.kind === "op" &&
      (peek() as { value: string }).value.match(/[+-]/)
    ) {
      const op = (next() as { value: "+" | "-" }).value;
      const right = parseTerm(depth);
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function parseTerm(depth: number): FitnessNode {
    let left = parseFactor(depth);
    while (
      peek()?.kind === "op" &&
      (peek() as { value: string }).value.match(/[*/]/)
    ) {
      const op = (next() as { value: "*" | "/" }).value;
      const right = parseFactor(depth);
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  function parseFactor(depth: number): FitnessNode {
    const t = peek();
    if (!t) throw new FitnessSyntaxError("Expression ended unexpectedly.");

    if (t.kind === "op" && t.value === "-") {
      next();
      return { type: "unary", op: "-", operand: parseFactor(depth + 1) };
    }
    if (t.kind === "op" && t.value === "+") {
      next();
      return parseFactor(depth);
    }
    if (t.kind === "num") {
      next();
      return { type: "number", value: t.value };
    }
    if (t.kind === "lparen") {
      next();
      const inner = parseExpr(depth + 1);
      expect("rparen", ")");
      return inner;
    }
    if (t.kind === "ident") {
      next();
      if (peek()?.kind === "lparen") {
        const name = t.value as FnName;
        if (!(name in FUNCTIONS)) {
          throw new FitnessSyntaxError(
            `Unknown function "${t.value}". Allowed: min, max, abs, clamp.`,
          );
        }
        next();
        const args: FitnessNode[] = [];
        if (peek()?.kind !== "rparen") {
          args.push(parseExpr(depth + 1));
          while (peek()?.kind === "comma") {
            next();
            args.push(parseExpr(depth + 1));
          }
        }
        expect("rparen", ")");
        const arity = FUNCTIONS[name].arity;
        if (args.length !== arity) {
          throw new FitnessSyntaxError(
            `${name}() takes ${arity} argument${arity > 1 ? "s" : ""}, got ${args.length}.`,
          );
        }
        return { type: "call", fn: name, args };
      }
      if (!isMetricName(t.value)) {
        throw new FitnessSyntaxError(
          `Unknown metric "${t.value}". Click a metric chip to see valid names.`,
        );
      }
      return { type: "metric", name: t.value };
    }
    throw new FitnessSyntaxError(
      "Expected a number, metric, or ( expression ).",
    );
  }

  function expect(kind: Token["kind"], display: string) {
    const t = next();
    if (!t || t.kind !== kind)
      throw new FitnessSyntaxError(`Expected "${display}".`);
  }

  const ast = parseExpr(0);
  if (pos !== tokens.length)
    throw new FitnessSyntaxError(
      "Unexpected trailing input — check your operators and parentheses.",
    );
  return ast;
}

export type CompiledFitness = { source: string; ast: FitnessNode };

export function compileFitness(source: string): CompiledFitness {
  const trimmed = source.trim();
  if (!trimmed) throw new FitnessSyntaxError("Fitness expression is empty.");
  return { source: trimmed, ast: parse(trimmed) };
}

export type FitnessValidation =
  | { ok: true; compiled: CompiledFitness; metricsUsed: MetricName[] }
  | { ok: false; error: string };

export function validateFitness(source: string): FitnessValidation {
  try {
    const compiled = compileFitness(source);
    return { ok: true, compiled, metricsUsed: metricsInNode(compiled.ast) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function evalNode(node: FitnessNode, m: FitnessMetrics): number {
  switch (node.type) {
    case "number":
      return node.value;
    case "metric":
      return m[node.name];
    case "unary":
      return -evalNode(node.operand, m);
    case "binary": {
      const a = evalNode(node.left, m);
      const b = evalNode(node.right, m);
      switch (node.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return b === 0 ? 0 : a / b; // safe divide — never NaN/Infinity from /0
      }
      return 0;
    }
    case "call": {
      const args = node.args.map((a) => evalNode(a, m));
      switch (node.fn) {
        case "min":
          return Math.min(args[0], args[1]);
        case "max":
          return Math.max(args[0], args[1]);
        case "abs":
          return Math.abs(args[0]);
        case "clamp":
          return Math.min(Math.max(args[0], args[1]), args[2]);
      }
      return 0;
    }
  }
}

const FITNESS_CAP = 1e6;

// Evaluate to a final score. We KEEP negatives (a flat floor at 0 makes gen-0
// selection random); only guard the truly broken values.
export function scoreFitness(ast: FitnessNode, m: FitnessMetrics): number {
  const raw = evalNode(ast, m);
  if (Number.isNaN(raw)) return -FITNESS_CAP;
  if (raw === Infinity) return FITNESS_CAP;
  if (raw === -Infinity) return -FITNESS_CAP;
  return raw;
}

// Break the score into the additive terms a human reads at the top level.
export function breakdownFitness(
  compiled: CompiledFitness,
  m: FitnessMetrics,
): FitnessBreakdownItem[] {
  const terms = flattenAdditive(compiled.ast, 1);
  return terms.map(({ node, sign }) => ({
    label: (sign < 0 ? "-" : "") + renderNode(node),
    value: sign * evalNode(node, m),
  }));
}

function flattenAdditive(
  node: FitnessNode,
  sign: number,
): Array<{ node: FitnessNode; sign: number }> {
  if (node.type === "binary" && (node.op === "+" || node.op === "-")) {
    return [
      ...flattenAdditive(node.left, sign),
      ...flattenAdditive(node.right, node.op === "-" ? -sign : sign),
    ];
  }
  return [{ node, sign }];
}

function renderNode(node: FitnessNode): string {
  switch (node.type) {
    case "number":
      return String(node.value);
    case "metric":
      return node.name;
    case "unary":
      return `-${renderNode(node.operand)}`;
    case "binary":
      return `${renderNode(node.left)} ${node.op} ${renderNode(node.right)}`;
    case "call":
      return `${node.fn}(${node.args.map(renderNode).join(", ")})`;
  }
}

function metricsInNode(
  node: FitnessNode,
  acc = new Set<MetricName>(),
): MetricName[] {
  switch (node.type) {
    case "metric":
      acc.add(node.name);
      break;
    case "unary":
      metricsInNode(node.operand, acc);
      break;
    case "binary":
      metricsInNode(node.left, acc);
      metricsInNode(node.right, acc);
      break;
    case "call":
      node.args.forEach((a) => metricsInNode(a, acc));
      break;
  }
  return [...acc];
}
