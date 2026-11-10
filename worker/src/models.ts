// The model menus. The Gateway catalog is the only source of model ids; nothing
// here names a model. A task's menu is the catalog filtered by the capabilities
// the task needs, in the Gateway's own order. Discovery is informational (the
// Gateway still admits or refuses every call), but checking an id against it
// turns a typo or a stale page into a clear 400 before any spend.
import type { CailClient, CailModelCatalogEntry } from "@cuny-ai-lab/cail-client";
import type { Env } from "./env";
import { E } from "./errors";

export type Task = "ocr" | "html_page" | "html_math" | "text";

export interface ModelOption {
  id: string;
  name: string;
  recommended: boolean;
  order: number;
  reasoning: boolean;
  vision: boolean;
  context_length: number | null;
}

const CACHE_MS = 60_000;
let cached: { at: number; list: ModelOption[] } | null = null;

/** For tests: forget the per-isolate catalog snapshot. */
export function resetCatalogCache(): void {
  cached = null;
}

function usable(entry: CailModelCatalogEntry): boolean {
  // Chat-capable text-generation models only (this also drops speech models the catalog marks recommended).
  return entry.status === "active" && entry.capabilities.includes("text-generation");
}

export function optionsFrom(entries: CailModelCatalogEntry[]): ModelOption[] {
  return entries
    .filter(usable)
    .sort((a, b) => a.order - b.order)
    .map((e) => ({
      id: e.id,
      name: e.name ?? e.id,
      recommended: e.recommended,
      order: e.order,
      reasoning: e.capabilities.includes("reasoning"),
      vision: e.capabilities.includes("vision"),
      context_length: e.context_length,
    }));
}

/** Catalog snapshot, cached per isolate for a minute. Fails closed: no hard-coded fallback model. */
export async function loadCatalog(client: CailClient, now = Date.now(), signal?: AbortSignal): Promise<ModelOption[]> {
  if (cached !== null && now - cached.at < CACHE_MS) return cached.list;
  let list: ModelOption[];
  try {
    list = optionsFrom((await client.getCatalogSnapshot({ ...(signal ? { signal } : {}) })).data);
  } catch {
    throw E.unavailable("The model catalog is unavailable right now. Try again shortly.", "catalog_unavailable");
  }
  if (list.length === 0) throw E.unavailable("The model catalog lists no usable models right now.", "catalog_unavailable");
  cached = { at: now, list };
  return list;
}

/** Menu for a task. Math prefers vision+reasoning models and falls back to any vision model. */
export function menuFor(task: Task, list: ModelOption[]): ModelOption[] {
  if (task === "text") return list;
  const vision = list.filter((m) => m.vision);
  if (task === "html_math") {
    const both = vision.filter((m) => m.reasoning);
    return both.length > 0 ? both : vision;
  }
  return vision;
}

const rank = (a: ModelOption, b: ModelOption): number => Number(b.recommended) - Number(a.recommended) || a.order - b.order;

/** Default for a task: a configured var if the live menu offers it, else the Gateway's own top-ranked model. */
export function defaultFor(task: Task, menu: ModelOption[], env: Env): ModelOption | null {
  const configured = task === "text" ? env.DEFAULT_TEXT_MODEL : task === "html_math" ? env.DEFAULT_MATH_MODEL : env.DEFAULT_VISION_MODEL;
  const hit = configured ? menu.find((m) => m.id === configured) : undefined;
  return hit ?? [...menu].sort(rank)[0] ?? null;
}

/** Resolve the model for one call: explicit choice > text setting > default. Must be on the task's live menu. */
export function resolveModel(task: Task, list: ModelOption[], env: Env, ...choices: (string | null | undefined)[]): ModelOption {
  const menu = menuFor(task, list);
  for (const choice of choices) {
    if (!choice) continue;
    const hit = menu.find((m) => m.id === choice);
    if (!hit) throw E.badRequest("That model is not offered for this task right now. Reload the model list and pick another.", "model_not_allowed");
    return hit;
  }
  const fallback = defaultFor(task, menu, env);
  if (!fallback) throw E.unavailable("No model with the needed capability is offered right now.", "no_model_available");
  return fallback;
}

// ---- reasoning headroom (Tool Maintainer Handoff, LanGames mount notes) -----
// Reasoning is billed as output: a tight max_tokens yields an empty reply with
// finish_reason "length". Headroom fixed all six affected models at 4,000;
// larger made one model reason past a two-minute timeout. The two switches
// save tokens on models that honor them, but a NON-reasoning model rejects
// them with 400 capability_unsupported, so they go only to reasoning models.
export const REASONING_HEADROOM = 4000;
export const REASONING_WANTED_HEADROOM = 8000;

export function reasoningPolicy(model: ModelOption, wantsThinking: boolean): { headroom: number; extraBody: Record<string, unknown> } {
  if (!model.reasoning) return { headroom: 0, extraBody: {} };
  if (wantsThinking) return { headroom: REASONING_WANTED_HEADROOM, extraBody: {} };
  return { headroom: REASONING_HEADROOM, extraBody: { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "low" } };
}
