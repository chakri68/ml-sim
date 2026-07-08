// The metric catalog — the vocabulary the fitness DSL is allowed to reference.
// Every headless evaluation fills in a FitnessMetrics object; the user's fitness
// expression reads from it and nothing else. Keeping this list small and honest
// matters: a metric a given body can never move (a rover has no limbs, so
// `limbGroundContactTime` is always 0) is worse than useless — a user who writes
// `limbGroundContactTime * 5` gets silent zero and thinks evolution is broken.
// So each template declares which metrics are MEANINGFUL for it (see templates),
// and the fitness panel greys out the rest.

// Only metrics that V1 actually computes live here. Target-based metrics
// (distanceToTarget, targetReached) and breakable-joint metrics live in V2 when
// target terrain and joint-failure land — deliberately absent so no one writes a
// formula against a metric that is hard-wired to zero.
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

// Ordered for display in the metric-chip palette.
export const METRIC_CATALOG: MetricInfo[] = [
  {
    name: "distance",
    label: "distance",
    help: "Best forward reach, in metres (peak, not final).",
  },
  {
    name: "maxX",
    label: "maxX",
    help: "Alias of distance — furthest x ever reached.",
  },
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
    help: "Greatest height the body rose above its start (m).",
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
