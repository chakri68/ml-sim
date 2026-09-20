// Live network diagram: sensors on the left, hidden neurons in the middle,
// thrusters on the right. Edge thickness is |weight| and its style is the sign;
// each frame an edge brightens by how much signal is actually flowing through
// it right now (|weight × source activation|), so you can watch a reading
// propagate into a burn. Hovering an edge reads out the arithmetic (design §14).

import { svg } from "../../lib/dom.ts";
import { w1Index, w2Index } from "./brain.ts";
import type { BrainLayout } from "./types.ts";

const W = 540;
const ROW = 15;
const TOP = 10;
const FOOT = 24;
const X_IN = 136;
const X_HID = 300;
const X_OUT = 440;

type Edge = {
  line: SVGLineElement;
  weight: number;
  from: { layer: 0 | 1; index: number };
  label: string;
};

export type NetView = {
  el: SVGSVGElement;
  setNetwork(
    layout: BrainLayout,
    params: ArrayLike<number>,
    inputLabels: string[],
    outputLabels: string[],
  ): void;
  update(input: ArrayLike<number>, hidden: ArrayLike<number>, output: ArrayLike<number>): void;
  clear(): void;
};

export function createNetView(): NetView {
  const root = svg("svg", {
    class: "nl-net",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": "The focused rover's neural network: sensor inputs, hidden neurons, thruster outputs",
  });
  const edgeLayer = svg("g", { class: "nl-net-edges" });
  const hitLayer = svg("g", { class: "nl-net-hits" });
  const nodeLayer = svg("g", {});
  const textLayer = svg("g", {});
  const readout = svg("text", { class: "nl-net-readout", x: W / 2, "text-anchor": "middle" });
  root.append(edgeLayer, hitLayer, nodeLayer, textLayer, readout);

  let edges: Edge[] = [];
  let inNodes: SVGCircleElement[] = [];
  let hidNodes: SVGCircleElement[] = [];
  let outNodes: SVGCircleElement[] = [];
  let inValues: SVGTextElement[] = [];
  let outBars: SVGRectElement[] = [];
  let hover: Edge | null = null;
  let lastIn: ArrayLike<number> = [];
  let lastHid: ArrayLike<number> = [];

  const IDLE_HINT = "hover a connection to see its arithmetic";

  function column(n: number, rows: number): number[] {
    const off = TOP + ((rows - n) * ROW) / 2 + ROW / 2;
    return Array.from({ length: n }, (_, i) => off + i * ROW);
  }

  function setNetwork(
    l: BrainLayout,
    params: ArrayLike<number>,
    inputLabels: string[],
    outputLabels: string[],
  ) {
    const rows = Math.max(l.inputs, l.hidden, l.outputs, 1);
    const H = TOP + rows * ROW + FOOT;
    root.setAttribute("viewBox", `0 0 ${W} ${H}`);
    readout.setAttribute("y", String(H - 8));
    readout.textContent = IDLE_HINT;
    hover = null;

    const yIn = column(l.inputs, rows);
    const yHid = column(l.hidden, rows);
    const yOut = column(l.outputs, rows);

    edges = [];
    edgeLayer.replaceChildren();
    hitLayer.replaceChildren();
    const addEdge = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      weight: number,
      from: Edge["from"],
      label: string,
    ) => {
      const line = svg("line", {
        x1,
        y1,
        x2,
        y2,
        class: weight >= 0 ? "nl-edge nl-edge--pos" : "nl-edge nl-edge--neg",
        "stroke-width": (0.4 + Math.min(2.6, Math.abs(weight) * 1.2)).toFixed(2),
      });
      const hit = svg("line", { x1, y1, x2, y2, class: "nl-edge-hit" });
      const e: Edge = { line, weight, from, label };
      hit.addEventListener("pointerenter", () => {
        hover = e;
        line.classList.add("nl-edge--hover");
        refreshReadout();
      });
      hit.addEventListener("pointerleave", () => {
        if (hover === e) hover = null;
        line.classList.remove("nl-edge--hover");
        refreshReadout();
      });
      edgeLayer.append(line);
      hitLayer.append(hit);
      edges.push(e);
    };
    for (let h = 0; h < l.hidden; h++)
      for (let i = 0; i < l.inputs; i++)
        addEdge(
          X_IN,
          yIn[i],
          X_HID,
          yHid[h],
          params[w1Index(l, h, i)],
          { layer: 0, index: i },
          `${inputLabels[i]} → h${h + 1}`,
        );
    for (let o = 0; o < l.outputs; o++)
      for (let h = 0; h < l.hidden; h++)
        addEdge(
          X_HID,
          yHid[h],
          X_OUT,
          yOut[o],
          params[w2Index(l, o, h)],
          { layer: 1, index: h },
          `h${h + 1} → ${outputLabels[o]}`,
        );

    nodeLayer.replaceChildren();
    textLayer.replaceChildren();
    const node = (x: number, y: number) => {
      const c = svg("circle", { cx: x, cy: y, r: 5, class: "nl-node" });
      nodeLayer.append(c);
      return c;
    };
    inNodes = yIn.map((y) => node(X_IN, y));
    hidNodes = yHid.map((y) => node(X_HID, y));
    outNodes = yOut.map((y) => node(X_OUT, y));
    inValues = yIn.map((y, i) => {
      textLayer.append(
        svg("text", { class: "nl-net-label", x: 6, y: y + 4 }, inputLabels[i] ?? ""),
      );
      const v = svg("text", { class: "nl-net-value", x: X_IN - 12, y: y + 4, "text-anchor": "end" });
      textLayer.append(v);
      return v;
    });
    outBars = yOut.map((y, o) => {
      textLayer.append(
        svg("text", { class: "nl-net-label nl-net-label--out", x: X_OUT + 12, y: y - 3 }, outputLabels[o] ?? ""),
      );
      textLayer.append(svg("rect", { class: "nl-net-track", x: X_OUT + 12, y: y + 5, width: 80, height: 3 }));
      const bar = svg("rect", { class: "nl-net-bar", x: X_OUT + 12, y: y + 5, width: 0, height: 3 });
      textLayer.append(bar);
      return bar;
    });
  }

  const fmt = (v: number) => (v >= 0 ? " " : "") + v.toFixed(2);

  function refreshReadout() {
    if (!hover) {
      readout.textContent = IDLE_HINT;
      return;
    }
    const src = hover.from.layer === 0 ? lastIn : lastHid;
    const a = src[hover.from.index] ?? 0;
    readout.textContent = `${hover.label} · weight ${fmt(hover.weight)} · activation ${fmt(a)} · contribution ${fmt(hover.weight * a)}`;
  }

  function paintNode(c: SVGCircleElement, v: number) {
    const m = Math.min(1, Math.abs(v));
    c.setAttribute("class", v >= 0 ? "nl-node nl-node--pos" : "nl-node nl-node--neg");
    c.style.fillOpacity = (0.08 + 0.92 * m).toFixed(2);
  }

  function update(input: ArrayLike<number>, hidden: ArrayLike<number>, output: ArrayLike<number>) {
    lastIn = input;
    lastHid = hidden;
    for (let i = 0; i < inNodes.length; i++) {
      paintNode(inNodes[i], input[i] ?? 0);
      inValues[i].textContent = (input[i] ?? 0).toFixed(2);
    }
    for (let h = 0; h < hidNodes.length; h++) paintNode(hidNodes[h], hidden[h] ?? 0);
    for (let o = 0; o < outNodes.length; o++) {
      const u = output[o] ?? 0;
      paintNode(outNodes[o], u);
      outBars[o].setAttribute("width", (80 * Math.min(1, u)).toFixed(1));
    }
    for (const e of edges) {
      const a = (e.from.layer === 0 ? input : hidden)[e.from.index] ?? 0;
      const flow = Math.min(1, Math.abs(e.weight * a));
      e.line.style.strokeOpacity = (0.07 + 0.8 * flow).toFixed(2);
    }
    if (hover) refreshReadout();
  }

  function clear() {
    edges = [];
    edgeLayer.replaceChildren();
    hitLayer.replaceChildren();
    nodeLayer.replaceChildren();
    textLayer.replaceChildren();
    readout.textContent = "";
  }

  return { el: root, setNetwork, update, clear };
}
