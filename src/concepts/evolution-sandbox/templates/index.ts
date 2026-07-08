// Template registry. Adding a body to the sandbox is a data change here — the
// engine, evolution, view, and DSL are all template-agnostic. V2 adds Hybrid,
// Jumper, and Flipper (pure recombinations of the two physics primitives these
// two already cover).

import { roverTemplate } from "./rover.ts";
import { crawlerTemplate } from "./crawler.ts";
import type { Template } from "../types.ts";

export const templates: Template[] = [roverTemplate, crawlerTemplate];

export const defaultTemplate = templates[0];

export function findTemplate(id: string): Template {
  return templates.find((t) => t.id === id) ?? defaultTemplate;
}
