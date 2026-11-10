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

// ---- model policy -------------------------------------------------------------
// Which models are OFFERED (shown in a menu) and which is the DEFAULT, per task.
// The catalog still decides what exists and what each model can do; the policy
// only orders and narrows. Every list is a var (comma-separated; `*` at the end
// matches a prefix), with the built-in values below as the fallback when a var
// is absent. A model the policy names but the catalog no longer lists is
// skipped, so a renamed or retired model degrades to the next one in order and,
// if none is left, to the Gateway's own ranking. A person can still TYPE any
// model id the catalog offers with the needed capabilities; that is checked
// against the full capability menu, not the offered one.
//
// Evidence: docs/model-policy.md (live evaluation through the real Gateway,
// 2026-11-10, 82 calls on the precalculus textbook).
export interface ModelPolicy {
  /** Preference order for the default, per task. */
  order: Record<Task, string[]>;
  /** The math/tables menu offers ONLY these (in this order) when the catalog has any of them. */
  mathOffered: string[];
  /** Never offered in a menu or chosen as a default for any task (still typeable). */
  hidden: string[];
  /** Never offered or defaulted for the math/tables path (still typeable). */
  mathHidden: string[];
  /** Reasoning models that get the thinking-off switches on the math path too. */
  mathThinkingOff: string[];
}

export const BUILTIN_POLICY: ModelPolicy = Object.freeze({
  order: {
    ocr: ["deepseek-v4.1-flash-1017", "mistral-large-3-675b-instruct", "qwen3.8-27b", "gemma-4-26b-a4b-it"],
    html_page: ["deepseek-v4.1-flash-1017", "mistral-large-3-675b-instruct", "qwen3.8-27b", "gemma-4-26b-a4b-it"],
    html_math: ["magistral-small-2509", "deepseek-v4.1-flash-1017", "qwen3.8-27b"],
    text: ["deepseek-v4.1-flash-1017", "gpt-oss-120b", "mistral-large-3-675b-instruct"],
  },
  mathOffered: ["magistral-small-2509", "deepseek-v4.1-flash-1017", "qwen3.8-27b"],
  hidden: ["kimi-*"],
  mathHidden: ["gemma-*", "kimi-*"],
  mathThinkingOff: ["deepseek-v4.1-flash-1017"],
}) as ModelPolicy;

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}\*?$/;
function listVar(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value.split(",").map((s) => s.trim()).filter((s) => MODEL_ID_PATTERN.test(s));
}
const matches = (patterns: string[], id: string): boolean => patterns.some((p) => (p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : id === p));

/** The policy in force: vars where set, built-in values otherwise. DEFAULT_*_MODEL still wins first place. */
export function policyFrom(env: Env): ModelPolicy {
  const order = (task: Task, varValue: string | undefined, pinned: string | undefined) => {
    const base = listVar(varValue, BUILTIN_POLICY.order[task]);
    return pinned && MODEL_ID_PATTERN.test(pinned) ? [pinned, ...base.filter((m) => m !== pinned)] : base;
  };
  return {
    order: {
      ocr: order("ocr", env.MODEL_ORDER_VISION, env.DEFAULT_VISION_MODEL),
      html_page: order("html_page", env.MODEL_ORDER_VISION, env.DEFAULT_VISION_MODEL),
      html_math: order("html_math", env.MODEL_ORDER_MATH, env.DEFAULT_MATH_MODEL),
      text: order("text", env.MODEL_ORDER_TEXT, env.DEFAULT_TEXT_MODEL),
    },
    mathOffered: listVar(env.MATH_MODELS_OFFERED, BUILTIN_POLICY.mathOffered),
    hidden: listVar(env.MODELS_HIDDEN, BUILTIN_POLICY.hidden),
    mathHidden: listVar(env.MATH_MODELS_HIDDEN, BUILTIN_POLICY.mathHidden),
    mathThinkingOff: listVar(env.MATH_THINKING_OFF, BUILTIN_POLICY.mathThinkingOff),
  };
}

/** Put the policy's preferred models first (in its order), the rest in the catalog's order. */
function preferred(menu: ModelOption[], order: string[]): ModelOption[] {
  const first = order.map((id) => menu.find((m) => m.id === id)).filter((m): m is ModelOption => m !== undefined);
  return [...first, ...menu.filter((m) => !first.includes(m))];
}

/**
 * The menu a person is shown for a task. Math: only the measured models that
 * the catalog still lists; if none is left, the capability menu minus hidden
 * models (the catalog rule), so a rename never empties it.
 */
export function offeredMenu(task: Task, list: ModelOption[], policy: ModelPolicy): ModelOption[] {
  const menu = menuFor(task, list).filter((m) => !matches(policy.hidden, m.id) && !(task === "html_math" && matches(policy.mathHidden, m.id)));
  if (task === "html_math") {
    const offered = policy.mathOffered.map((id) => menu.find((m) => m.id === id)).filter((m): m is ModelOption => m !== undefined);
    if (offered.length > 0) return preferred(offered, policy.order.html_math);
  }
  return preferred(menu, policy.order[task]);
}

/** Default for a task: the first model of the policy's order on the offered menu, else the Gateway's top-ranked offered model. */
export function defaultFor(task: Task, offered: ModelOption[], policy: ModelPolicy): ModelOption | null {
  for (const id of policy.order[task]) {
    const hit = offered.find((m) => m.id === id);
    if (hit) return hit;
  }
  return [...offered].sort(rank)[0] ?? null;
}

/** Does this model think on the math path? (Thinking off for models the evidence shows reason past the budget.) */
export const thinksOnMath = (model: ModelOption, policy: ModelPolicy): boolean => !matches(policy.mathThinkingOff, model.id);

/**
 * Resolve the model for one call: explicit choice > text setting > default.
 * A choice must be on the task's CAPABILITY menu (typed ids are allowed even
 * when the policy does not offer them); the default comes from the offered menu.
 */
export function resolveModel(task: Task, list: ModelOption[], env: Env, ...choices: (string | null | undefined)[]): ModelOption {
  const menu = menuFor(task, list);
  for (const choice of choices) {
    if (!choice) continue;
    const hit = menu.find((m) => m.id === choice);
    if (!hit) throw E.badRequest("That model is not offered for this task right now. Reload the model list and pick another.", "model_not_allowed");
    return hit;
  }
  const policy = policyFrom(env);
  const fallback = defaultFor(task, offeredMenu(task, list, policy), policy);
  if (!fallback) throw E.unavailable("No model with the needed capability is offered right now.", "no_model_available");
  return fallback;
}

/**
 * The model for one run: a model the person running chose for it (any on the
 * capability menu, as resolveModel), else the text's saved setting, else the
 * default. A saved setting was written by any editor of the text and is paid
 * from the allowance of whoever runs the task, so it must be on the OFFERED
 * menu: a model the policy hides (Kimi everywhere, Gemma for math) is used only
 * when the person paying names it for the run.
 */
export function resolveRunModel(task: Task, list: ModelOption[], env: Env, chosen: string | null | undefined, saved: string | null | undefined): ModelOption {
  if (chosen) return resolveModel(task, list, env, chosen);
  if (saved) {
    const hit = resolveModel(task, list, env, saved); // model_not_allowed when the catalog no longer offers it for the task at all
    if (!offeredMenu(task, list, policyFrom(env)).some((m) => m.id === hit.id)) {
      throw E.badRequest("The model saved for this text is not one this tool offers. Choose a model for this run, or change the text's model settings.", "saved_model_not_offered");
    }
    return hit;
  }
  return resolveModel(task, list, env);
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
