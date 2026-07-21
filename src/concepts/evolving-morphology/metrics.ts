// The metric catalog — the vocabulary the fitness DSL will reference in later
// milestones. Identical in spirit to the Evolution Sandbox: every headless
// evaluation fills in a FitnessMetrics object, and (eventually) the user's
// fitness expression reads from it and nothing else. Copied rather than imported
// so this concept stays self-contained and never couples to the sandbox.

export const METRIC_NAMES = [
  "distance",
  "maxX",
  "finalX",
  "averageSpeed",
  "survivalTime",
  "energyUsed",
  "spinTime",
  "flipCount",
  "jumpHeight",
  "airtime",
  "bodyGroundContactTime",
  "wheelGroundContactTime",
  "limbGroundContactTime",
  "stability",
  "instability",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export type FitnessMetrics = Record<MetricName, number>;

export type MetricInfo = {
  name: MetricName;
  label: string;
  help: string;
};

export const METRIC_CATALOG: MetricInfo[] = [
  {
    name: "distance",
    label: "distance",
    help: "Best forward reach, in metres (peak, not final).",
  },
  { name: "maxX", label: "maxX", help: "Furthest x ever reached." },
  {
    name: "finalX",
    label: "finalX",
    help: "Where it ended up when the clock ran out.",
  },
  {
    name: "averageSpeed",
    label: "averageSpeed",
    help: "Mean forward velocity over the run (m/s).",
  },
  {
    name: "survivalTime",
    label: "survivalTime",
    help: "Seconds simulated before it exploded or was aborted.",
  },
  {
    name: "energyUsed",
    label: "energyUsed",
    help: "Total motor work — a proxy for effort.",
  },
  {
    name: "spinTime",
    label: "spinTime",
    help: "Seconds spent spinning faster than a threshold.",
  },
  {
    name: "flipCount",
    label: "flipCount",
    help: "Number of full body rotations completed.",
  },
  {
    name: "jumpHeight",
    label: "jumpHeight",
    help: "Greatest height the body rose above its lowest point (m).",
  },
  {
    name: "airtime",
    label: "airtime",
    help: "Seconds with nothing touching the ground.",
  },
  {
    name: "bodyGroundContactTime",
    label: "bodyGroundContactTime",
    help: "Seconds the main body dragged on the ground.",
  },
  {
    name: "wheelGroundContactTime",
    label: "wheelGroundContactTime",
    help: "Seconds a wheel was in contact.",
  },
  {
    name: "limbGroundContactTime",
    label: "limbGroundContactTime",
    help: "Seconds a limb touched the ground.",
  },
  {
    name: "stability",
    label: "stability",
    help: "Uprightness integral — high means it stayed level.",
  },
  {
    name: "instability",
    label: "instability",
    help: "Accumulated runaway-motion seconds — high means chaos.",
  },
];

const METRIC_SET = new Set<string>(METRIC_NAMES);

export function isMetricName(name: string): name is MetricName {
  return METRIC_SET.has(name);
}

export function emptyMetrics(): FitnessMetrics {
  const m = {} as FitnessMetrics;
  for (const name of METRIC_NAMES) m[name] = 0;
  return m;
}
