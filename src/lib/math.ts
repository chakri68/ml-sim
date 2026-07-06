// Shared numeric + coordinate helpers.

export type Bounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Maps math coordinates -> pixel coordinates inside a padded box.
export function projector(
  bounds: Bounds,
  width: number,
  height: number,
  pad: number,
) {
  const w = width - pad * 2;
  const h = height - pad * 2;
  return {
    x(x: number): number {
      return pad + ((x - bounds.xMin) / (bounds.xMax - bounds.xMin)) * w;
    },
    y(y: number): number {
      return pad + h - ((y - bounds.yMin) / (bounds.yMax - bounds.yMin)) * h;
    },
  };
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
