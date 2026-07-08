// Rare background easter-egg signs planted out on the terrain. Pure decoration —
// never physics, never collidable. Rolled once per generation: usually nothing,
// but now and then a little hand-lettered sign turns up somewhere down the track,
// leaning at an angle (never perfectly upright), with something to say.

export type TerrainSign = { x: number; text: string; angle: number };

const MESSAGES = [
  "How's life going?",
  "You okay out there?",
  "keep going :)",
  "you've got this",
  "are we there yet?",
  "nice day for it",
  "wrong way?",
  "believe in yourself",
  "touch grass →",
  "hi :)",
  "so far so good?",
  "mind the gap",
];

const CHANCE = 0.2; // ~20% of generations get a sign
const MIN_X = 10; // planted somewhere out on the track (metres)
const MAX_X = 46;
const MAX_TILT = 0.22; // radians (~12.5°) — leaned, so it never looks "perfect"

// Non-deterministic on purpose: signs are cosmetic, so a fresh roll each
// generation (and each session) keeps them surprising. Returns 0 or 1 sign.
export function rollTerrainSigns(): TerrainSign[] {
  if (Math.random() > CHANCE) return [];
  return [
    {
      x: MIN_X + Math.random() * (MAX_X - MIN_X),
      text: MESSAGES[Math.floor(Math.random() * MESSAGES.length)],
      angle: (Math.random() - 0.5) * 2 * MAX_TILT,
    },
  ];
}
