// Template registry. Adding a body to the sandbox is a data change here — the
// engine, evolution, view, and DSL are all template-agnostic. Every template is
// assembled from two physics primitives (the WheelJoint wheel and the revolute
// sine-motor limb, see parts.ts); the five below are recombinations of those.

import { roverTemplate } from "./rover.ts";
import { crawlerTemplate } from "./crawler.ts";
import { reflexCrawlerTemplate } from "./reflex-crawler.ts";
import { hybridTemplate } from "./hybrid.ts";
import { jumperTemplate } from "./jumper.ts";
import { flipperTemplate } from "./flipper.ts";
import type { Template } from "../types.ts";

export const templates: Template[] = [
  roverTemplate,
  crawlerTemplate,
  reflexCrawlerTemplate,
  hybridTemplate,
  jumperTemplate,
  flipperTemplate,
];

export const defaultTemplate = templates[0];

export function findTemplate(id: string): Template {
  return templates.find((t) => t.id === id) ?? defaultTemplate;
}
