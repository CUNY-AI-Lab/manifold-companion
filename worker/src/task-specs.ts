// The model tasks as pure data: request builders (messages, token budget,
// temperature, thinking, deadline) and output parsers. The Hono routes in
// routes/tasks.ts and the live evaluation harness (scripts/live-eval.mjs)
// both use these, so what is measured against the real Gateway is exactly
// what ships. No I/O and no Hono here.
import { AppError } from "./errors";
import type { ChatTask } from "./gateway";
import type { ModelOption } from "./models";
import { cleanOcr, extractHtml, postprocessPageHtml, stripReasoning, visibleLength } from "./model-output";
import { DEFAULT_OCR_PROMPT, FORMULA_REPAIR_SYSTEM, HTML_PAGE_SYSTEM, htmlPageUser, summarySystem, translationSystem } from "./prompts";
import { sanitizeHtml } from "./sanitize/html";

/** Per-text overrides from text_settings; null means the task default. */
export interface TaskSettings { prompt?: string | null; max_tokens?: number | null; temperature?: number | null }

export const TASK_DEFAULTS = {
  ocr: { maxTokens: 4096, temperature: 0.1 },
  html_page: { maxTokens: 6000, temperature: 0.1 },
  summary: { maxTokens: 1024, temperature: 0.3 },
  translate: { maxTokens: 6000, temperature: 0.3 },
  formula_repair: { maxTokens: 4000, temperature: 0 },
} as const;

export const MAX_SUMMARY_INPUT_CHARS = 100_000;
export const MAX_TRANSLATE_CHUNK_CHARS = 12_000;
export const SUMMARY_MAX_BYTES = 20 * 1024;

export function ocrTask(model: ModelOption, imageDataUri: string, settings: TaskSettings = {}, promptOverride?: string): ChatTask {
  const prompt = promptOverride || settings.prompt || DEFAULT_OCR_PROMPT;
  return {
    model, deadline: "ocr", wantsThinking: false,
    maxTokens: settings.max_tokens ?? TASK_DEFAULTS.ocr.maxTokens, temperature: settings.temperature ?? TASK_DEFAULTS.ocr.temperature,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUri } }] }],
  };
}

/** OCR output as stored: reasoning blocks and runaway repeats removed. Empty is an error. */
export function parseOcr(raw: string): string {
  const text = cleanOcr(raw);
  if (text === "") throw new AppError({ code: "empty_ocr", message: "The model returned no readable text for this page.", status: 422 });
  return text;
}

export interface PageHtmlInput {
  imageDataUri: string;
  pageNumber: number;
  totalPages: number | null;
  hint: string;
  math: boolean;
  /** Math path only: false sends the thinking-off switches (models the policy lists in mathThinkingOff). */
  thinking?: boolean;
  figures?: { filename: string; width: number | null; height: number | null }[];
}

export function pageHtmlTask(model: ModelOption, input: PageHtmlInput, settings: TaskSettings = {}): ChatTask {
  return {
    model, deadline: input.math ? "html_math" : "html_page", wantsThinking: input.math && input.thinking !== false,
    maxTokens: settings.max_tokens ?? TASK_DEFAULTS.html_page.maxTokens, temperature: settings.temperature ?? TASK_DEFAULTS.html_page.temperature,
    messages: [
      { role: "system", content: HTML_PAGE_SYSTEM },
      { role: "user", content: [{ type: "text", text: htmlPageUser(input.pageNumber, input.totalPages, input.figures ?? [], input.hint) }, { type: "image_url", image_url: { url: input.imageDataUri } }] },
    ],
  };
}

/** The page HTML exactly as the route returns it: extracted, post-processed, sanitized. */
export function parsePageHtml(raw: string, pageNumber: number): { unsanitized: string; html: string; shortOutput: boolean } {
  const unsanitized = postprocessPageHtml(extractHtml(raw), pageNumber);
  const html = sanitizeHtml(unsanitized);
  return { unsanitized, html, shortOutput: visibleLength(html) < 40 };
}

export function summaryTask(model: ModelOption, source: string, language: string): { task: ChatTask; truncatedInput: boolean } {
  const truncatedInput = source.length > MAX_SUMMARY_INPUT_CHARS;
  const input = truncatedInput ? `${source.slice(0, MAX_SUMMARY_INPUT_CHARS)}\n\n[text truncated]` : source;
  return {
    truncatedInput,
    task: { model, deadline: "text", wantsThinking: false, maxTokens: TASK_DEFAULTS.summary.maxTokens, temperature: TASK_DEFAULTS.summary.temperature, messages: [{ role: "system", content: summarySystem(language) }, { role: "user", content: input }] },
  };
}

const byteLength = (s: string): number => new TextEncoder().encode(s).byteLength;

/** Summary as stored (bounded for the D1 row). */
export function parseSummary(raw: string): string {
  const summary = stripReasoning(raw).trim();
  return byteLength(summary) > SUMMARY_MAX_BYTES ? summary.slice(0, Math.floor(SUMMARY_MAX_BYTES / 4)) : summary;
}

export function translateTask(model: ModelOption, text: string, source: string, target: string): ChatTask {
  return { model, deadline: "translate", wantsThinking: false, maxTokens: TASK_DEFAULTS.translate.maxTokens, temperature: TASK_DEFAULTS.translate.temperature, messages: [{ role: "system", content: translationSystem(source, target) }, { role: "user", content: text }] };
}

export const parseTranslation = (raw: string): string => stripReasoning(raw).trim();

export function formulaRepairTask(model: ModelOption, formulas: string[]): ChatTask {
  return { model, deadline: "text", wantsThinking: false, maxTokens: TASK_DEFAULTS.formula_repair.maxTokens, temperature: TASK_DEFAULTS.formula_repair.temperature, messages: [{ role: "system", content: FORMULA_REPAIR_SYSTEM }, { role: "user", content: JSON.stringify(formulas) }] };
}

/** One repair per formula, as JSON strings; anything else is bad_model_output. */
export function parseFormulaRepair(raw: string, formulas: string[]): { original: string; repaired: string }[] {
  let repaired: unknown;
  try {
    repaired = JSON.parse(stripReasoning(raw).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  } catch {
    repaired = null;
  }
  if (!Array.isArray(repaired) || repaired.length !== formulas.length || repaired.some((x) => typeof x !== "string" || x.length > 4000)) {
    throw new AppError({ code: "bad_model_output", message: "The model did not return usable repairs. Try again or pick another model.", status: 502 });
  }
  return formulas.map((original, i) => ({ original, repaired: repaired[i] as string }));
}
