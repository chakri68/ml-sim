// Two tiny SVG charts for the stage footer: a multi-line chart (landing rate,
// fitness) and a stacked area of how episodes ended per generation, so you can
// watch the *kind* of failure change, not just the amount (design §31).

import { svg } from "../../lib/dom.ts";

const W = 420;
const H = 110;
const PAD_X = 6;
const PAD_Y = 8;

export type LineChart = {
  el: SVGSVGElement;
  draw(series: number[][], range?: { min: number; max: number }): void;
};

export function createLineChart(opts: { ariaLabel: string; classes: string[] }): LineChart {
  const lines = opts.classes.map((cls) => svg("polyline", { class: cls }));
  const axis = svg("line", {
    x1: PAD_X,
    y1: H - PAD_Y,
    x2: W - PAD_X,
    y2: H - PAD_Y,
    class: "ec-graph-axis",
  });
  const el = svg(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      class: "nl-chart",
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": opts.ariaLabel,
    },
    axis,
    ...lines,
  );

  function draw(series: number[][], range?: { min: number; max: number }) {
    const n = Math.max(0, ...series.map((s) => s.length));
    if (n < 2) {
      for (const l of lines) l.setAttribute("points", "");
      return;
    }
    let min = range?.min ?? Infinity;
    let max = range?.max ?? -Infinity;
    if (!range)
      for (const s of series)
        for (const v of s)
          if (Number.isFinite(v)) {
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
    if (!(max > min)) max = min + 1;
    const px = (i: number) => PAD_X + (i / (n - 1)) * (W - PAD_X * 2);
    const py = (v: number) => H - PAD_Y - ((v - min) / (max - min)) * (H - PAD_Y * 2);
    series.forEach((s, k) => {
      let pts = "";
      s.forEach((v, i) => {
        if (Number.isFinite(v)) pts += `${px(i).toFixed(1)},${py(v).toFixed(1)} `;
      });
      lines[k]?.setAttribute("points", pts);
    });
  }

  return { el, draw };
}

export type StackChart = {
  el: SVGSVGElement;
  draw(rows: number[][]): void; // rows[gen][band], fractions summing to 1
};

export function createStackChart(opts: { ariaLabel: string; classes: string[] }): StackChart {
  const bands = opts.classes.map((cls) => svg("path", { class: cls }));
  const el = svg(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      class: "nl-chart",
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": opts.ariaLabel,
    },
    ...bands,
  );

  function draw(rows: number[][]) {
    const n = rows.length;
    if (n < 2) {
      for (const b of bands) b.setAttribute("d", "");
      return;
    }
    const px = (i: number) => PAD_X + (i / (n - 1)) * (W - PAD_X * 2);
    const py = (f: number) => H - PAD_Y - f * (H - PAD_Y * 2);
    const base = new Array<number>(n).fill(0);
    bands.forEach((band, k) => {
      const top = rows.map((r, i) => base[i] + (r[k] ?? 0));
      let d = `M ${px(0).toFixed(1)} ${py(top[0]).toFixed(1)}`;
      for (let i = 1; i < n; i++) d += ` L ${px(i).toFixed(1)} ${py(top[i]).toFixed(1)}`;
      for (let i = n - 1; i >= 0; i--) d += ` L ${px(i).toFixed(1)} ${py(base[i]).toFixed(1)}`;
      band.setAttribute("d", `${d} Z`);
      for (let i = 0; i < n; i++) base[i] = top[i];
    });
  }

  return { el, draw };
}
