// Fitness presets — now DSL expression strings, not hardcoded functions. They're
// starting points a user edits: pick one, then rewrite it. Each keeps a small
// spin/energy penalty so honest walkers beat the cheats. "Minimalist" rewards
// distance-per-effort, which — with structural mutation live — pressures evolution
// to DROP legs it isn't using: the reward reshaping the body, on purpose.

export type FitnessPreset = {
  id: string;
  label: string;
  help: string;
  expression: string;
};

export const FITNESS_PRESETS: FitnessPreset[] = [
  {
    id: "go-far",
    label: "Go Far",
    help: "Reward raw forward distance; lightly penalize spinning and effort.",
    expression:
      "distance * 10 + survivalTime * 0.4 - spinTime * 6 - energyUsed * 0.02",
  },
  {
    id: "go-fast",
    label: "Go Fast",
    help: "Reward average forward speed over the run.",
    expression: "averageSpeed * 40 + distance * 2 - spinTime * 6",
  },
  {
    id: "efficient",
    label: "Efficient",
    help: "Cover ground for as little motor work as possible.",
    expression: "distance * 10 - energyUsed * 0.06 - spinTime * 6",
  },
  {
    id: "upright",
    label: "Stay Upright",
    help: "Reward distance while staying level and off its belly.",
    expression:
      "distance * 6 + stability * 8 - bodyGroundContactTime * 4 - spinTime * 6",
  },
  {
    id: "minimalist",
    label: "Minimalist",
    help: "Distance per effort — heavy energy penalty. Watch it shed legs.",
    expression: "distance * 10 - energyUsed * 0.12",
  },
];

export const DEFAULT_PRESET_ID = "go-far";

export function findPreset(id: string): FitnessPreset {
  return FITNESS_PRESETS.find((p) => p.id === id) ?? FITNESS_PRESETS[0];
}
