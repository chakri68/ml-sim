// The heavy visualization engine (pulls in Three.js + mathjs). Loaded lazily by
// index.ts so the homepage stays light — this whole module is its own chunk.
import { el } from "../../lib/dom.ts";
import {
  compileCustom,
  findFunction,
  presets,
  type FuncDef,
} from "./functions.ts";
import { findOptimizer, optimizers, type Stepper } from "./optimizers.ts";
import { createView2D } from "./view2d.ts";
import { createView3D } from "./view3d.ts";
import type { EngineState, Status, View } from "./view.ts";

const EPSILON = 0.05; // gradient-norm threshold for "at the minimum"
const BASE_STEPS_PER_SEC = 2.5;

const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

export function mount(root: HTMLElement): () => void {
  const initial = presets[0];
  const state = {
    func: initial as FuncDef,
    dim: initial.dim as 1 | 2,
    optimizerId: "gd",
    pos: initial.start.slice(),
    start: initial.start.slice(),
    gradient: initial.grad(initial.start),
    trail: [] as number[][],
    step: 0,
    lr: 0.1,
    noise: 0,
    speed: 1,
    running: false,
    status: "Idle" as Status,
  };

  let stepper: Stepper = findOptimizer(state.optimizerId).create(state.dim);
  let view: View = createView2D(state.func, reducedMotion);
  let raf = 0;
  let last = 0;
  let acc = 0;
  let lastPresetByDim: Record<number, string> = {
    1: presets.find((p) => p.dim === 1)!.id,
    2: presets.find((p) => p.dim === 2)!.id,
  };
  let customFunc: FuncDef | null = null;

  const engineState = (): EngineState => ({
    func: state.func,
    pos: state.pos,
    gradient: state.gradient,
    trail: state.trail,
    step: state.step,
    status: state.status,
  });

  // --- stats ---------------------------------------------------------------
  const stat = (label: string) => {
    const value = el("span", { class: "gd-stat-value" }, "—");
    const row = el(
      "div",
      { class: "gd-stat" },
      el("span", { class: "gd-stat-label" }, label),
      value,
    );
    return { row, value };
  };
  const stepStat = stat("step");
  const posStat = stat("position");
  const fxStat = stat("f");
  const gradStat = stat("gradient");
  const optStat = stat("optimizer");
  const statusBadge = el(
    "span",
    { class: "gd-status", "data-status": "idle" },
    "Idle",
  );

  function refreshStats() {
    stepStat.value.textContent = String(state.step);
    posStat.value.textContent =
      state.dim === 2
        ? `(${state.pos[0].toFixed(2)}, ${state.pos[1].toFixed(2)})`
        : state.pos[0].toFixed(2);
    const f = state.func.fn(state.pos);
    fxStat.value.textContent = Number.isFinite(f) ? f.toFixed(2) : "∞";
    gradStat.value.textContent =
      state.dim === 2
        ? `|∇| ${norm(state.gradient).toFixed(2)}`
        : state.gradient[0].toFixed(2);
    optStat.value.textContent = findOptimizer(state.optimizerId).label;
    statusBadge.textContent = state.status;
    statusBadge.setAttribute(
      "data-status",
      state.status.toLowerCase().replace(/\s+/g, "-"),
    );
  }

  function draw() {
    view.update(engineState());
    refreshStats();
  }

  // --- core step -----------------------------------------------------------
  function diverged(next: number[]): boolean {
    if (!next.every(Number.isFinite)) return true;
    return state.func.domain.some(([lo, hi], i) => {
      const center = (lo + hi) / 2;
      return Math.abs(next[i] - center) > (hi - lo) * 4;
    });
  }

  function doStep() {
    const grad = state.func.grad(state.pos);
    const prevF = state.func.fn(state.pos);
    const next = stepper(state.pos, grad, state.lr, state.noise);

    if (diverged(next)) {
      state.gradient = grad;
      state.status = "Diverging";
      stop();
      draw();
      return;
    }

    state.trail.push(state.pos.slice());
    state.pos = next;
    state.step += 1;
    state.gradient = state.func.grad(state.pos);

    if (norm(state.gradient) < EPSILON) {
      state.status = "Near minimum";
      stop();
    } else {
      const newF = state.func.fn(state.pos);
      state.status = newF > prevF + 1e-9 ? "Overshooting" : "Converging";
    }
    draw();
  }

  // --- loop ----------------------------------------------------------------
  function frame(t: number) {
    if (!last) last = t;
    const dt = (t - last) / 1000;
    last = t;
    acc += dt * BASE_STEPS_PER_SEC * state.speed;
    while (acc >= 1 && state.running) {
      acc -= 1;
      doStep();
    }
    if (state.running) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (state.running) return;
    if (state.status === "Near minimum" || state.status === "Diverging")
      reset();
    state.running = true;
    state.status = "Running";
    last = 0;
    acc = 0;
    raf = requestAnimationFrame(frame);
    syncButtons();
  }

  function stop() {
    state.running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    syncButtons();
  }

  function reset() {
    stop();
    stepper = findOptimizer(state.optimizerId).create(state.dim);
    state.pos = state.start.slice();
    state.step = 0;
    state.gradient = state.func.grad(state.pos);
    state.trail = [];
    state.status = "Idle";
    draw();
  }

  function rebuildView() {
    view.dispose();
    view =
      state.dim === 2
        ? createView3D(state.func, reducedMotion)
        : createView2D(state.func, reducedMotion);
    sceneHolder.replaceChildren(view.el);
    reset();
  }

  // --- function / dimension switching -------------------------------------
  function setFunction(func: FuncDef) {
    const dimChanged = func.dim !== state.dim;
    state.func = func;
    state.dim = func.dim;
    state.start = func.start.slice();
    if (!func.custom) lastPresetByDim[func.dim] = func.id;
    startSlider.field.style.display = func.dim === 1 ? "" : "none";
    if (func.dim === 1) {
      const [lo, hi] = func.domain[0];
      startSlider.setBounds(lo, hi);
      startSlider.setValue(func.start[0]);
    }
    fnNote.textContent = func.note;
    if (dimChanged) {
      rebuildFnOptions();
      syncDimToggle();
    }
    fnSelect.value = func.custom ? "custom" : func.id;
    customRow.style.display = func.custom ? "" : "none";
    rebuildView();
  }

  function setDimension(dim: 1 | 2) {
    if (dim === state.dim) return;
    const targetId = lastPresetByDim[dim];
    setFunction(findFunction(targetId));
  }

  // --- controls ------------------------------------------------------------
  function slider(opts: {
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format: (v: number) => string;
    onInput: (v: number) => void;
  }) {
    const valueEl = el(
      "span",
      { class: "gd-slider-value" },
      opts.format(opts.value),
    );
    const input = el("input", {
      type: "range",
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: String(opts.value),
      class: "gd-slider-input",
      name: opts.label.split(" ")[0].toLowerCase(),
      "aria-label": opts.label,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const v = Number(input.value);
      valueEl.textContent = opts.format(v);
      opts.onInput(v);
    });
    const field = el(
      "label",
      { class: "gd-field" },
      el(
        "span",
        { class: "gd-field-head" },
        el("span", {}, opts.label),
        valueEl,
      ),
      input,
    );
    return {
      field,
      setValue: (v: number) => {
        input.value = String(v);
        valueEl.textContent = opts.format(v);
      },
      setBounds: (lo: number, hi: number) => {
        input.min = String(lo);
        input.max = String(hi);
      },
    };
  }

  const lrSlider = slider({
    label: "Learning rate (α)",
    min: 0.01,
    max: 1.5,
    step: 0.01,
    value: state.lr,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      state.lr = v;
      refreshStats();
    },
  });
  const startSlider = slider({
    label: "Starting point (x₀)",
    min: initial.domain[0][0],
    max: initial.domain[0][1],
    step: 0.1,
    value: state.start[0],
    format: (v) => v.toFixed(1),
    onInput: (v) => {
      state.start[0] = v;
      reset();
    },
  });
  const noiseSlider = slider({
    label: "Gradient noise (mini-batches)",
    min: 0,
    max: 1.2,
    step: 0.05,
    value: state.noise,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      state.noise = v;
    },
  });
  const speedSlider = slider({
    label: "Playback speed (visual only)",
    min: 0.25,
    max: 3,
    step: 0.25,
    value: state.speed,
    format: (v) => `${v}×`,
    onInput: (v) => {
      state.speed = v;
    },
  });

  // dimension toggle
  const dim1Btn = el(
    "button",
    { type: "button", class: "gd-seg gd-seg--on" },
    "1D curve",
  );
  const dim3Btn = el(
    "button",
    { type: "button", class: "gd-seg" },
    "3D surface",
  );
  dim1Btn.addEventListener("click", () => setDimension(1));
  dim3Btn.addEventListener("click", () => setDimension(2));
  function syncDimToggle() {
    dim1Btn.classList.toggle("gd-seg--on", state.dim === 1);
    dim3Btn.classList.toggle("gd-seg--on", state.dim === 2);
  }
  const dimToggle = el(
    "div",
    { class: "gd-seg-group", role: "group", "aria-label": "Dimension" },
    dim1Btn,
    dim3Btn,
  );

  // function selector
  const fnSelect = el("select", {
    class: "gd-select",
    name: "loss-function",
    "aria-label": "Loss function",
  }) as HTMLSelectElement;
  function rebuildFnOptions() {
    fnSelect.replaceChildren(
      ...presets
        .filter((p) => p.dim === state.dim)
        .map((p) => el("option", { value: p.id }, p.label)),
      el("option", { value: "custom" }, "Custom…"),
    );
  }
  rebuildFnOptions();
  fnSelect.addEventListener("change", () => {
    if (fnSelect.value === "custom") {
      customInput.value = customFunc?.expr ?? state.func.expr;
      customRow.style.display = "";
      applyCustom();
    } else {
      customRow.style.display = "none";
      setFunction(findFunction(fnSelect.value));
    }
  });
  const fnNote = el("p", { class: "gd-fn-note" }, state.func.note);

  // custom-expression input
  const customInput = el("input", {
    type: "text",
    class: "gd-text",
    name: "custom-expr",
    "aria-label": "Custom function expression",
    placeholder: "e.g. sin(x) + 0.1x^2   or   x^2 + y^2",
  }) as HTMLInputElement;
  const customError = el("p", { class: "gd-error" });
  const applyBtn = el(
    "button",
    { type: "button", class: "gd-btn gd-btn--wide" },
    "Apply function",
  );
  function applyCustom() {
    const result = compileCustom(customInput.value);
    if (!result.ok) {
      customError.textContent = result.error;
      return;
    }
    customError.textContent = "";
    customFunc = result.func;
    setFunction(result.func);
  }
  applyBtn.addEventListener("click", applyCustom);
  customInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") applyCustom();
  });
  const customRow = el(
    "div",
    { class: "gd-custom" },
    el(
      "span",
      { class: "gd-hint" },
      "Use x (and y for a surface). ^ power, sin, cos, exp, log, abs, sqrt…",
    ),
    customInput,
    applyBtn,
    customError,
  );
  customRow.style.display = "none";

  // optimizer selector
  const optSelect = el(
    "select",
    { class: "gd-select", name: "optimizer", "aria-label": "Optimizer" },
    ...optimizers.map((o) => el("option", { value: o.id }, o.label)),
  ) as HTMLSelectElement;
  optSelect.addEventListener("change", () => {
    state.optimizerId = optSelect.value;
    optNote.textContent = findOptimizer(state.optimizerId).description;
    reset();
  });
  const optNote = el(
    "p",
    { class: "gd-fn-note" },
    findOptimizer(state.optimizerId).description,
  );

  // buttons
  const btn = (label: string, onClick: () => void, primary = false) =>
    el(
      "button",
      {
        type: "button",
        class: primary ? "gd-btn gd-btn--primary" : "gd-btn",
        onClick,
      },
      label,
    );
  const startBtn = btn("Start", start, true);
  const pauseBtn = btn("Pause", stop);
  const stepBtn = btn("Step once", () => {
    stop();
    doStep();
  });
  const resetBtn = btn("Reset", reset);
  const randomBtn = btn("Randomize", () => {
    state.start = state.func.domain.map(([lo, hi]) =>
      Number((lo + Math.random() * (hi - lo)).toFixed(2)),
    );
    state.lr = Number((0.02 + Math.random() * 0.5).toFixed(2));
    lrSlider.setValue(state.lr);
    if (state.dim === 1) startSlider.setValue(state.start[0]);
    reset();
  });
  function syncButtons() {
    startBtn.toggleAttribute("disabled", state.running);
    pauseBtn.toggleAttribute("disabled", !state.running);
  }

  // --- layout --------------------------------------------------------------
  const explanation = el(
    "section",
    { class: "gd-explanation" },
    el("h3", {}, "What's happening?"),
    el(
      "p",
      {},
      "Gradient descent minimizes a function by repeatedly stepping in the ",
      el("strong", {}, "opposite direction of the slope"),
      ". The ",
      el("strong", {}, "learning rate"),
      " sets the step size — too large and it overshoots, then diverges.",
    ),
    el(
      "p",
      {},
      "Switch to the ",
      el("strong", {}, "3D surface"),
      " and compare optimizers on the ravine: plain GD zig-zags across the steep walls while ",
      el("strong", {}, "RMSProp"),
      " and ",
      el("strong", {}, "Adam"),
      " adapt their step per-direction and cut straight down the valley. ",
      el("strong", {}, "Momentum"),
      " builds speed along the trough.",
    ),
    el(
      "p",
      { class: "gd-tip" },
      "Drag to orbit the surface. Type your own function above — use x for a curve, or x and y for a surface.",
    ),
  );

  const sceneHolder = el(
    "div",
    { class: "gd-scene-holder" },
    view.el,
    explanation,
  );
  const controls = el(
    "aside",
    { class: "gd-controls" },
    el(
      "div",
      { class: "gd-status-row" },
      el("span", { class: "gd-controls-title" }, "Status"),
      statusBadge,
    ),
    field("View", dimToggle),
    field("Loss function", fnSelect),
    fnNote,
    customRow,
    field("Optimizer", optSelect),
    optNote,
    lrSlider.field,
    startSlider.field,
    noiseSlider.field,
    speedSlider.field,
    el(
      "div",
      { class: "gd-buttons" },
      startBtn,
      pauseBtn,
      stepBtn,
      resetBtn,
      randomBtn,
    ),
    el(
      "div",
      { class: "gd-stats" },
      stepStat.row,
      posStat.row,
      fxStat.row,
      gradStat.row,
      optStat.row,
    ),
  );

  const page = el(
    "div",
    { class: "gd-page" },
    el(
      "header",
      { class: "gd-header" },
      el("a", { href: "#/", class: "gd-back" }, "← All concepts"),
      el("h1", {}, "Gradient Descent"),
      el(
        "p",
        { class: "gd-sub" },
        "Look at the slope, step in the opposite direction, repeat — in 1D, in 3D, and with five optimizers.",
      ),
    ),
    el("div", { class: "gd-main" }, sceneHolder, controls),
  );

  root.replaceChildren(page);
  startSlider.field.style.display = state.dim === 1 ? "" : "none";
  syncButtons();
  draw();

  return () => {
    stop();
    view.dispose();
  };
}

// small labelled control wrapper
function field(label: string, control: HTMLElement): HTMLElement {
  return el(
    "label",
    { class: "gd-field" },
    el("span", { class: "gd-field-head" }, el("span", {}, label)),
    control,
  );
}
