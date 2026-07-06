// Optimizer variants, dimension-agnostic. Each works on a parameter vector
// (length 1 for the 1D curve, length 2 for the 3D surface), so the same code
// drives both modes. A factory captures per-run state; reset = make a new one.

export type Stepper = (
  pos: number[],
  grad: number[],
  lr: number,
  noise: number,
) => number[];

export type Optimizer = {
  id: string;
  label: string;
  description: string;
  create: (dim: number) => Stepper;
};

// Standard normal sample (Box–Muller). Browser Math.random is fine here.
function gaussian(): number {
  const u = Math.random() || 1e-9;
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Simulate mini-batch gradient noise: multiplicative, so jitter scales with the
// gradient and stays unit-free. `baseline` is the optimizer's own noise floor.
function noisy(grad: number[], noise: number, baseline: number): number[] {
  const amount = noise + baseline;
  if (amount <= 0) return grad;
  return grad.map((g) => g * (1 + amount * gaussian()));
}

function zeros(dim: number): number[] {
  return new Array(dim).fill(0);
}

const BETA = 0.9; // momentum / RMSProp decay
const B1 = 0.9; // Adam first moment
const B2 = 0.999; // Adam second moment
const EPS = 1e-8;

export const optimizers: Optimizer[] = [
  {
    id: "gd",
    label: "Gradient Descent",
    description:
      "The plain update: step directly against the full gradient. Simple, but zig-zags in narrow valleys.",
    create: () => (pos, grad, lr, noise) => {
      const g = noisy(grad, noise, 0);
      return pos.map((p, i) => p - lr * g[i]);
    },
  },
  {
    id: "sgd",
    label: "SGD (stochastic)",
    description:
      "Gradient descent on noisy, mini-batch-style gradients. The path wanders — noise can also help escape shallow traps.",
    create: () => (pos, grad, lr, noise) => {
      const g = noisy(grad, noise, 0.35); // baseline stochasticity even at noise 0
      return pos.map((p, i) => p - lr * g[i]);
    },
  },
  {
    id: "momentum",
    label: "Momentum",
    description:
      "Accumulates a velocity that carries through flat regions and cancels side-to-side zig-zag. Faster along valleys.",
    create: (dim) => {
      let v = zeros(dim);
      return (pos, grad, lr, noise) => {
        const g = noisy(grad, noise, 0);
        v = v.map((vi, i) => BETA * vi - lr * g[i]);
        return pos.map((p, i) => p + v[i]);
      };
    },
  },
  {
    id: "rmsprop",
    label: "RMSProp",
    description:
      "Divides each step by a running estimate of that direction's gradient size. Adapts the step per-axis, so steep and flat directions move at similar rates.",
    create: (dim) => {
      let s = zeros(dim);
      return (pos, grad, lr, noise) => {
        const g = noisy(grad, noise, 0);
        s = s.map((si, i) => BETA * si + (1 - BETA) * g[i] * g[i]);
        return pos.map((p, i) => p - (lr * g[i]) / (Math.sqrt(s[i]) + EPS));
      };
    },
  },
  {
    id: "adam",
    label: "Adam",
    description:
      "Momentum + RMSProp together, with bias correction. The go-to default in deep learning — smooth and robust across curvatures.",
    create: (dim) => {
      let m = zeros(dim);
      let s = zeros(dim);
      let t = 0;
      return (pos, grad, lr, noise) => {
        const g = noisy(grad, noise, 0);
        t += 1;
        m = m.map((mi, i) => B1 * mi + (1 - B1) * g[i]);
        s = s.map((si, i) => B2 * si + (1 - B2) * g[i] * g[i]);
        const mc = m.map((mi) => mi / (1 - B1 ** t));
        const sc = s.map((si) => si / (1 - B2 ** t));
        return pos.map((p, i) => p - (lr * mc[i]) / (Math.sqrt(sc[i]) + EPS));
      };
    },
  },
];

export function findOptimizer(id: string): Optimizer {
  return optimizers.find((o) => o.id === id) ?? optimizers[0];
}
