// Starter fitness objectives. Most users should begin here and then tweak — the
// interesting lesson happens when they change one weight and watch the champion's
// behaviour mutate to match. Each preset is just a DSL string; nothing here is
// privileged over what a user could type by hand.

export type FitnessPreset = {
  id: string;
  label: string;
  expression: string;
  note: string;
};

export const FITNESS_PRESETS: FitnessPreset[] = [
  {
    id: "go-far",
    label: "Go Far",
    expression:
      "distance * 10 + survivalTime * 0.5 - energyUsed * 0.03 - spinTime * 5",
    note: "Reward reach, gently punish flailing and spinning. The default sane goal.",
  },
  {
    id: "go-fast",
    label: "Go Fast",
    expression: "averageSpeed * 40 + distance * 2 - instability * 4",
    note: "Reward raw forward speed. Watch stability suffer.",
  },
  {
    id: "efficient",
    label: "Use Less Energy",
    expression: "distance * 10 - energyUsed * 0.5",
    note: "Distance per unit of effort. Favours lazy, economical movement.",
  },
  {
    id: "stable",
    label: "Stay Stable",
    expression:
      "distance * 4 + stability * 8 - spinTime * 8 - bodyGroundContactTime * 3",
    note: "Move, but stay upright and off your belly.",
  },
  {
    id: "jump-high",
    label: "Jump High",
    expression: "jumpHeight * 12 + airtime * 3 - energyUsed * 0.04",
    note: "Reward getting off the ground. (Best with limbed bodies.)",
  },
  {
    id: "do-flips",
    label: "Do Flips",
    expression: "flipCount * 60 + jumpHeight * 4",
    note: "The monkey's-paw classic: reward rotations and watch it stop caring about anything else.",
  },
];

export const DEFAULT_PRESET_ID = "go-far";

export function findPreset(id: string): FitnessPreset | undefined {
  return FITNESS_PRESETS.find((p) => p.id === id);
}
