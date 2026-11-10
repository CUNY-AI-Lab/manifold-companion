// Pure parts of the live evaluation harness (scripts/live-eval.mjs): argument
// parsing, the call plan, cost arithmetic, key redaction, output scoring and
// the report. No I/O. Unit-tested in test/live-eval.test.ts.
import temml from "temml";
import { defaultFor, menuFor, reasoningPolicy, type ModelOption, type Task } from "../src/models";

// ---- arguments ---------------------------------------------------------------

export const TASKS = ["ocr", "html", "math", "summary", "translate", "repair"] as const;
export type EvalTask = (typeof TASKS)[number];

export interface EvalArgs {
  dryRun: boolean;
  out: string | null;
  budgetMicrodollars: number;
  budgetMode: "worst" | "expected";
  tasks: EvalTask[];
  models: string[] | null;
  pages: string[] | null;
  mathbook: string | null;
  help: boolean;
}

/** Flags only. A key is never accepted here: anything that looks like one aborts the run. */
export function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { dryRun: false, out: null, budgetMicrodollars: 1_500_000, budgetMode: "worst", tasks: [...TASKS], models: null, pages: null, mathbook: null, help: false };
  const list = (v: string | undefined, flag: string): string[] => {
    if (!v) throw new Error(`${flag} needs a comma-separated value`);
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  };
  // Every argument, including flag values, is checked before anything is parsed.
  if (argv.some((a) => looksLikeKey(a) || looksLikeKey(a.slice(a.indexOf("=") + 1)))) throw new Error("Never pass the key as an argument. Pipe it on stdin.");
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--dry-run": args.dryRun = true; break;
      case "--help": case "-h": args.help = true; break;
      case "--out": args.out = value() ?? null; break;
      case "--mathbook": args.mathbook = value() ?? null; break;
      case "--budget-microdollars": {
        const n = Number(value());
        if (!Number.isInteger(n) || n <= 0) throw new Error("--budget-microdollars must be a positive integer");
        args.budgetMicrodollars = n;
        break;
      }
      case "--budget-mode": {
        const m = value();
        if (m !== "worst" && m !== "expected") throw new Error("--budget-mode is worst or expected");
        args.budgetMode = m;
        break;
      }
      case "--tasks": {
        const t = list(value(), flag);
        for (const x of t) if (!(TASKS as readonly string[]).includes(x)) throw new Error(`unknown task ${x} (use ${TASKS.join(",")})`);
        args.tasks = t as EvalTask[];
        break;
      }
      case "--models": args.models = list(value(), flag); break;
      case "--pages": args.pages = list(value(), flag); break;
      default: throw new Error(`unknown argument ${flag}`);
    }
  }
  return args;
}

export const looksLikeKey = (s: string): boolean => /sk-cail|^sk-[A-Za-z0-9_-]{16,}|^[A-Za-z0-9_-]{40,}$/.test(s);

/** Remove every occurrence of the key (and of its bearer form) from text. */
export function redact(text: string, key: string | null | undefined): string {
  if (!key || key.length < 4) return text;
  return text.split(`Bearer ${key}`).join("Bearer [redacted]").split(key).join("[redacted]");
}

// ---- pages -------------------------------------------------------------------

export interface PageSpec {
  id: string;
  pdf: "ch1" | "ch7";
  page: number;
  why: string;
}

export const BOOK_FILES = { ch1: "Chapter_1_Functions.pdf", ch7: "Chapter_7_Trigonometric_Equations_and_Identities.pdf" } as const;

// Chosen by looking at the rendered pages.
export const PAGES: PageSpec[] = [
  { id: "ch7-p2", pdf: "ch7", page: 2, why: "identity reference box laid out as a grid, stacked fractions, a worked example, a graph" },
  { id: "ch7-p7", pdf: "ch7", page: 7, why: "radicals and nested fractions, multi-line derivations, a boxed topics list" },
  { id: "ch7-p8", pdf: "ch7", page: 8, why: "dense two-column exercise grid of trig equations (squared functions, fractions of pi)" },
  { id: "ch7-p15", pdf: "ch7", page: 15, why: "worked example with a two-column derivation layout, inverse trig, approximations" },
  { id: "ch1-p35", pdf: "ch1", page: 35, why: "six graphs of piecewise functions and piecewise definitions with cases" },
  { id: "ch1-p19", pdf: "ch1", page: 19, why: "twelve small In/Out tables and a matching exercise" },
];

export const PAGES_FOR: Record<"ocr" | "html" | "math", string[]> = {
  ocr: ["ch7-p2", "ch7-p7", "ch7-p8"],
  html: ["ch7-p2", "ch7-p7", "ch7-p8", "ch1-p19"],
  math: ["ch7-p2", "ch7-p7", "ch7-p8", "ch7-p15", "ch1-p35", "ch1-p19"],
};

/**
 * The browser client's rendering rule (worker/client/src/lib/pdf.js renderPage):
 * pdf.js scales 2, 1.5, 1.2 (math pages 3, 2.5, 2, 1.5) of 72 dpi, JPEG quality
 * 0.88 (then 0.75), until the image is at most 3.5 MiB. OCR pages come from the
 * same renderer (PDF uploads in an image project are rasterised with it).
 */
export const RENDER = {
  standardDpi: [144, 108, 86],
  mathDpi: [216, 180, 144, 108],
  jpegQualities: [88, 75],
  maxBytes: 3.5 * 1024 * 1024,
} as const;

// ---- plan --------------------------------------------------------------------

export interface Pricing { input: number; output: number }

export interface PlannedCall {
  n: number;
  task: EvalTask;
  workerTask: Task;
  page: string | null;
  model: ModelOption;
  isDefault: boolean;
  maxTokens: number;
  headroom: number;
  switches: boolean;
  estInputTokens: number;
  estOutputTokens: number;
  expectedMicro: number | null;
  worstMicro: number | null;
}

export const WORKER_TASK: Record<EvalTask, Task> = { ocr: "ocr", html: "html_page", math: "html_math", summary: "text", translate: "text", repair: "text" };
export const MAX_TOKENS: Record<EvalTask, number> = { ocr: 4096, html: 6000, math: 6000, summary: 1024, translate: 6000, repair: 4000 };
/** Rough visible-output expectations for the "expected" budget mode and the dry-run estimate. */
const TYPICAL_OUTPUT: Record<EvalTask, number> = { ocr: 1200, html: 2500, math: 2800, summary: 350, translate: 1100, repair: 120 };
const TYPICAL_REASONING_MATH = 3000;

/** Very rough image token estimate (a 28-32 px patch grid); the real figure is the provider's. */
export const estimateImageTokens = (width: number, height: number): number => Math.ceil(width / 32) * Math.ceil(height / 32);
export const estimateTextTokens = (chars: number): number => Math.ceil(chars / 4);

/** Microdollars: catalog prices are USD per million tokens, i.e. microdollars per token. */
export function costMicro(promptTokens: number | null, completionTokens: number | null, pricing: Pricing | null | undefined): number | null {
  if (!pricing || promptTokens === null || completionTokens === null) return null;
  return Math.round(promptTokens * pricing.input + completionTokens * pricing.output);
}

export interface CandidateSets {
  /** The Worker's menu for the task (what a person could pick). */
  menu: ModelOption[];
  /** The model the Worker would use with no choice made. */
  default: ModelOption | null;
  /** What this run calls, in order (default first). */
  run: ModelOption[];
}

/**
 * Candidates per task, computed with the Worker's own rules (menuFor,
 * defaultFor). Comparison sets: OCR and standard HTML run every RECOMMENDED
 * vision model; the math path runs every vision+reasoning model on its menu
 * (cheapest first after the recommended ones, so a budget stop keeps the
 * most informative); text tasks run every recommended text model.
 */
export function candidates(task: EvalTask, catalog: ModelOption[], prices: Map<string, Pricing>, filter: string[] | null): CandidateSets {
  const menu = menuFor(WORKER_TASK[task], catalog);
  const dflt = defaultFor(WORKER_TASK[task], menu, {} as never);
  let set: ModelOption[];
  if (task === "math") {
    const price = (m: ModelOption) => (prices.get(m.id)?.output ?? Number.POSITIVE_INFINITY);
    set = [...menu].sort((a, b) => Number(b.recommended) - Number(a.recommended) || price(a) - price(b) || a.order - b.order);
  } else {
    set = menu.filter((m) => m.recommended);
  }
  if (dflt) set = [dflt, ...set.filter((m) => m.id !== dflt.id)];
  if (filter) set = set.filter((m) => filter.includes(m.id));
  return { menu, default: dflt, run: set };
}

export function planCall(n: number, task: EvalTask, page: string | null, model: ModelOption, isDefault: boolean, estInputTokens: number, pricing: Pricing | null): PlannedCall {
  const policy = reasoningPolicy(model, task === "math");
  const maxTokens = MAX_TOKENS[task];
  const typical = TYPICAL_OUTPUT[task] + (model.reasoning ? (task === "math" ? TYPICAL_REASONING_MATH : 800) : 0);
  const estOutputTokens = Math.min(typical, maxTokens + policy.headroom);
  return {
    n, task, workerTask: WORKER_TASK[task], page, model, isDefault, maxTokens, headroom: policy.headroom, switches: Object.keys(policy.extraBody).length > 0,
    estInputTokens, estOutputTokens,
    expectedMicro: costMicro(estInputTokens, estOutputTokens, pricing),
    worstMicro: costMicro(estInputTokens, maxTokens + policy.headroom, pricing),
  };
}

/** Should the next call run? Stops BEFORE the budget could be exceeded. */
export function budgetAllows(spentMicro: number, call: PlannedCall, budget: number, mode: "worst" | "expected"): boolean {
  const next = mode === "worst" ? call.worstMicro : call.expectedMicro;
  // Unknown price: assume the most expensive catalog rate seen (16.5 $/M output) for safety.
  const fallback = Math.round(call.estInputTokens * 3.3 + (mode === "worst" ? call.maxTokens + call.headroom : call.estOutputTokens) * 16.5);
  return spentMicro + (next ?? fallback) <= budget;
}

// ---- scoring -----------------------------------------------------------------

export interface TexFragment { tex: string; display: boolean; delimiter: string }

/** TeX fragments in the delimiters the app renders: \( \), \[ \], $$ $$, and (Markdown only) $ $. */
export function texFragments(text: string, markdown = false): TexFragment[] {
  const out: TexFragment[] = [];
  const patterns: [RegExp, boolean, string][] = [
    [/\\\[([\s\S]{1,4000}?)\\\]/g, true, "\\["],
    [/\$\$([\s\S]{1,4000}?)\$\$/g, true, "$$"],
    [/\\\(([\s\S]{1,2000}?)\\\)/g, false, "\\("],
  ];
  let rest = text;
  for (const [re, display, delimiter] of patterns) {
    rest = rest.replace(re, (_m, tex: string) => {
      out.push({ tex, display, delimiter });
      return " ";
    });
  }
  if (markdown) {
    for (const m of rest.matchAll(/(?<![\\$\w])\$(?!\s)([^$\n]{1,500}?)(?<!\s)\$(?![\w$])/g)) out.push({ tex: m[1] as string, display: false, delimiter: "$" });
  }
  return out;
}

const decodeEntities = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Does temml render this TeX without error (trust off, as in export)? */
export function texParses(tex: string): boolean {
  try {
    temml.renderToString(decodeEntities(tex.trim()), { throwOnError: true });
    return true;
  } catch {
    return false;
  }
}

/** <math>...</math> elements (outermost). */
export function mathElements(html: string): string[] {
  const out: string[] = [];
  const re = /<math\b[^>]*>[\s\S]*?<\/math>/gi;
  for (const m of html.matchAll(re)) out.push(m[0]);
  return out;
}

/** A MathML element is well formed if its tags balance, it has content and holds no <merror>. */
export function mathmlWellFormed(el: string): boolean {
  if (/<merror\b/i.test(el)) return false;
  const stack: string[] = [];
  for (const m of el.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*?(\/?)>/gi)) {
    const [, closing, rawName, selfClosing] = m;
    const name = (rawName as string).toLowerCase();
    if (selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0 && el.replace(/<[^>]+>/g, "").trim().length > 0;
}

export interface MathScore { total: number; valid: number; tex: number; texValid: number; mathml: number; mathmlValid: number; invalidSamples: string[] }

export function scoreMath(text: string, markdown = false): MathScore {
  const frags = texFragments(text, markdown);
  const texValid = frags.filter((f) => texParses(f.tex));
  const mml = markdown ? [] : mathElements(text);
  const mmlValid = mml.filter(mathmlWellFormed);
  const invalidSamples = [...frags.filter((f) => !texParses(f.tex)).map((f) => f.tex), ...mml.filter((e) => !mathmlWellFormed(e))].slice(0, 5).map((s) => s.slice(0, 200));
  return { total: frags.length + mml.length, valid: texValid.length + mmlValid.length, tex: frags.length, texValid: texValid.length, mathml: mml.length, mathmlValid: mmlValid.length, invalidSamples };
}

function countTags(html: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b/g)) {
    const n = (t[1] as string).toLowerCase();
    m.set(n, (m.get(n) ?? 0) + 1);
  }
  return m;
}
function countAttrs(html: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const tag of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const a of (tag[0] as string).slice(1).matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=/g)) {
      const n = (a[1] as string).toLowerCase();
      m.set(n, (m.get(n) ?? 0) + 1);
    }
  }
  return m;
}

/** What the sanitizer removed: element and attribute counts present before and missing after. */
export function strippedBySanitizer(before: string, after: string): { tags: Record<string, number>; attrs: Record<string, number>; intact: boolean } {
  const diff = (a: Map<string, number>, b: Map<string, number>) => {
    const out: Record<string, number> = {};
    for (const [k, v] of a) if (v > (b.get(k) ?? 0)) out[k] = v - (b.get(k) ?? 0);
    return out;
  };
  // rel is added by the sanitizer on links, not removed
  const tags = diff(countTags(before), countTags(after));
  const attrs = diff(countAttrs(before), countAttrs(after));
  return { tags, attrs, intact: Object.keys(tags).length === 0 && Object.keys(attrs).length === 0 };
}

export interface StructureScore { headings: number; tables: number; lists: number; sections: number; images: number; figures: number }

export function htmlStructure(html: string): StructureScore {
  const c = (re: RegExp) => (html.match(re) ?? []).length;
  return { headings: c(/<h[1-6]\b/gi), tables: c(/<table\b/gi), lists: c(/<(ul|ol)\b/gi), sections: c(/<section\b/gi), images: c(/<img\b/gi), figures: c(/<figure\b/gi) };
}

export function markdownStructure(md: string): StructureScore {
  const lines = md.split("\n");
  return {
    headings: lines.filter((l) => /^#{1,6}\s/.test(l)).length,
    // A table separator row has a pipe; a bare --- is the page separator.
    tables: lines.filter((l) => /^\s*\|?\s*:?-{3,}:?\s*\|/.test(l)).length,
    lists: lines.filter((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l)).length,
    sections: lines.filter((l) => /^-{3,}\s*$/.test(l)).length,
    images: 0,
    figures: 0,
  };
}

export const hasFence = (s: string): boolean => /```/.test(s);
export const REFUSAL = /\b(I can(?:no|')t (?:help|assist|process|transcribe|read)|I'm (?:sorry|unable)|I am (?:sorry|unable)|unable to (?:assist|help|process|read|transcribe)|as an AI\b|cannot (?:see|view) (?:the )?image)/i;
export const isRefusal = (s: string): boolean => REFUSAL.test(s);
export const leaksReasoning = (s: string): boolean => /<\/?(think|thinking|reasoning)>/i.test(s);

const STOPWORDS: Record<string, string[]> = {
  it: ["il", "di", "che", "la", "e", "per", "una", "sono", "con", "non", "della", "delle", "si", "un"],
  es: ["el", "de", "que", "la", "y", "en", "los", "las", "una", "por", "con", "para", "es", "se"],
  en: ["the", "of", "and", "to", "is", "in", "that", "for", "we", "this", "with", "a"],
};

/** Share of words that are common stopwords of `lang` (a crude "is this Italian?" check). */
export function languageScore(text: string, lang: keyof typeof STOPWORDS): number {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return 0;
  const set = new Set(STOPWORDS[lang]);
  return words.filter((w) => set.has(w)).length / words.length;
}

/** Damage one real formula: drop its last closing brace (or parenthesis). Null if nothing to damage. */
export function damageFormula(tex: string): string | null {
  for (const ch of ["}", ")", "]"]) {
    const i = tex.lastIndexOf(ch);
    if (i >= 0) {
      const broken = tex.slice(0, i) + tex.slice(i + 1);
      if (!texParses(broken)) return broken;
    }
  }
  const swapped = tex.replace(/\\frac/, "\\frca");
  return swapped !== tex && !texParses(swapped) ? swapped : null;
}

/** Pick a real formula from model outputs to damage: the longest that renders and has a brace. */
export function pickRepairSource(outputs: string[]): string | null {
  const all = outputs.flatMap((o) => texFragments(o).map((f) => f.tex.trim())).filter((t) => t.length >= 8 && t.length <= 300 && /[{}]/.test(t) && texParses(t));
  all.sort((a, b) => b.length - a.length);
  return all[0] ?? null;
}

// ---- records and report ------------------------------------------------------

export interface CallRecord {
  n: number;
  task: EvalTask;
  page: string | null;
  model: string;
  isDefault: boolean;
  reasoning: boolean;
  ok: boolean;
  status: number | null;
  errorCode: string | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  usage: Record<string, unknown> | null;
  provider: string | null;
  latencyMs: number;
  deadlineHit: boolean;
  outputChars: number;
  maxTokensSent: number;
  thinkingSwitches: boolean;
  imageBytes: number | null;
  costMicro: number | null;
  costSource: "usage" | "catalog" | "none";
  quality: Record<string, unknown>;
  mathTotal: number;
  mathValid: number;
}

export function usageNumbers(usage: Record<string, unknown> | null): { prompt: number | null; completion: number | null; reasoning: number | null; reportedCostMicro: number | null } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const details = (usage?.completion_tokens_details ?? usage?.output_tokens_details) as Record<string, unknown> | undefined;
  const reasoning = num(details?.reasoning_tokens) ?? num(usage?.reasoning_tokens);
  // A cost the Gateway or provider reports, if any (no such field is documented; recorded raw anyway).
  const cost = num(usage?.cost_micro_usd) ?? (num(usage?.cost) !== null ? Math.round((usage!.cost as number) * 1e6) : null);
  return { prompt: num(usage?.prompt_tokens) ?? num(usage?.input_tokens), completion: num(usage?.completion_tokens) ?? num(usage?.output_tokens), reasoning, reportedCostMicro: cost };
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
};

export interface Aggregate {
  task: EvalTask;
  model: string;
  calls: number;
  ok: number;
  okRate: number;
  medianLatencyMs: number | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  truncations: number;
  deadlineHits: number;
  mathValid: number;
  mathTotal: number;
  costMicro: number;
  errors: Record<string, number>;
  maxTokensSent: number;
  thinkingSwitches: boolean;
}

export function aggregate(records: CallRecord[]): Aggregate[] {
  const groups = new Map<string, CallRecord[]>();
  for (const r of records) {
    const k = `${r.task}\u0000${r.model}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.values()].map((rs) => {
    const first = rs[0] as CallRecord;
    const errors: Record<string, number> = {};
    for (const r of rs) if (!r.ok) errors[r.errorCode ?? "unknown"] = (errors[r.errorCode ?? "unknown"] ?? 0) + 1;
    const ok = rs.filter((r) => r.ok).length;
    return {
      task: first.task, model: first.model, calls: rs.length, ok, okRate: ok / rs.length,
      medianLatencyMs: median(rs.map((r) => r.latencyMs)),
      promptTokens: rs.reduce((n, r) => n + (r.promptTokens ?? 0), 0),
      completionTokens: rs.reduce((n, r) => n + (r.completionTokens ?? 0), 0),
      reasoningTokens: rs.reduce((n, r) => n + (r.reasoningTokens ?? 0), 0),
      truncations: rs.filter((r) => r.errorCode === "model_output_truncated" || r.errorCode === "model_output_empty" || r.finishReason === "length").length,
      deadlineHits: rs.filter((r) => r.deadlineHit).length,
      mathValid: rs.reduce((n, r) => n + r.mathValid, 0),
      mathTotal: rs.reduce((n, r) => n + r.mathTotal, 0),
      costMicro: rs.reduce((n, r) => n + (r.costMicro ?? 0), 0),
      errors,
      maxTokensSent: first.maxTokensSent,
      thinkingSwitches: first.thinkingSwitches,
    };
  });
}

/** Rank models for a task: completion, then formula validity, then cost, then latency. */
export function rankModels(aggs: Aggregate[], task: EvalTask): Aggregate[] {
  const ratio = (a: Aggregate) => (a.mathTotal === 0 ? 0 : a.mathValid / a.mathTotal);
  return aggs
    .filter((a) => a.task === task && a.ok > 0)
    .sort((a, b) => b.okRate - a.okRate || ratio(b) - ratio(a) || a.costMicro / Math.max(1, a.ok) - b.costMicro / Math.max(1, b.ok) || (a.medianLatencyMs ?? 0) - (b.medianLatencyMs ?? 0));
}

/** Models to keep off the menu for a task: never answered, mostly truncated, or refused. */
export function exclusions(aggs: Aggregate[], records: CallRecord[]): { task: EvalTask; model: string; reason: string }[] {
  const out: { task: EvalTask; model: string; reason: string }[] = [];
  for (const a of aggs) {
    const refused = records.some((r) => r.task === a.task && r.model === a.model && r.quality.refusal === true);
    if (a.ok === 0) out.push({ task: a.task, model: a.model, reason: `no successful call (${Object.entries(a.errors).map(([k, v]) => `${k} x${v}`).join(", ")})` });
    else if (a.truncations / a.calls >= 0.5) out.push({ task: a.task, model: a.model, reason: `stopped on the token limit in ${a.truncations} of ${a.calls} calls at max_tokens ${a.maxTokensSent}` });
    else if (refused) out.push({ task: a.task, model: a.model, reason: "refusal text in output" });
  }
  return out;
}

const usd = (micro: number | null | undefined): string => (micro === null || micro === undefined ? "n/a" : `$${(micro / 1e6).toFixed(4)}`);

export interface ReportInput {
  generatedAt: string;
  records: CallRecord[];
  quotaBefore: { limit: number; estimated_used: number } | null;
  quotaAfter: { limit: number; estimated_used: number } | null;
  budgetMicrodollars: number;
  spentMicro: number;
  stoppedByBudget: number;
  menus: Record<string, { default: string | null; menu: string[]; run: string[] }>;
  pages: Record<string, { bytes: number; width: number; height: number; dpi: number; why: string }>;
  notes: string[];
}

export function buildReport(input: ReportInput): { json: unknown; markdown: string } {
  const aggs = aggregate(input.records);
  const std = rankModels(aggs, "html");
  const ocr = rankModels(aggs, "ocr");
  const math = rankModels(aggs, "math");
  const exclude = exclusions(aggs, input.records);
  const quotaDelta = input.quotaBefore && input.quotaAfter ? input.quotaAfter.estimated_used - input.quotaBefore.estimated_used : null;
  const recommendation = {
    standardVision: std[0]?.model ?? ocr[0]?.model ?? null,
    ocr: ocr[0]?.model ?? null,
    math: math[0]?.model ?? null,
    basis: "highest success rate, then share of formulas that parse, then cost per successful call, then latency",
  };
  const lines: string[] = [];
  lines.push("# Live evaluation: Manifold Companion model tasks", "");
  lines.push(`Generated ${input.generatedAt}. Calls: ${input.records.length}; skipped for budget: ${input.stoppedByBudget}.`);
  lines.push(`Estimated spend from usage x catalog price: ${usd(input.spentMicro)} of a ${usd(input.budgetMicrodollars)} budget.`);
  lines.push(`Gateway /quota estimated_used before ${usd(input.quotaBefore?.estimated_used)}, after ${usd(input.quotaAfter?.estimated_used)}, difference ${usd(quotaDelta)} (the Gateway's figure is delayed; a difference smaller than the estimate usually means it has not caught up).`, "");
  lines.push("## Recommendation", "");
  lines.push(`- Default standard vision model (page image to HTML; also OCR unless noted): **${recommendation.standardVision ?? "none succeeded"}**`);
  lines.push(`- Best OCR model: **${recommendation.ocr ?? "none succeeded"}**`);
  lines.push(`- Default math/tables model: **${recommendation.math ?? "none succeeded"}**`);
  lines.push(`- Ranking: ${recommendation.basis}. Read the side-by-side previews (index.html) before changing defaults: formula fidelity is not scored automatically beyond "parses".`, "");
  if (exclude.length) {
    lines.push("### Exclude from the menu (for the task named)", "");
    for (const e of exclude) lines.push(`- ${e.task}: \`${e.model}\`: ${e.reason}`);
    lines.push("");
  }
  for (const task of TASKS) {
    const rows = aggs.filter((a) => a.task === task);
    if (rows.length === 0) continue;
    lines.push(`## ${task}`, "");
    if (input.menus[task]) lines.push(`Worker menu default: \`${input.menus[task].default}\`; models run: ${input.menus[task].run.map((m) => `\`${m}\``).join(", ")}.`, "");
    lines.push("| model | ok | median latency | prompt tok | completion tok | reasoning tok | length stops | deadline | math valid/total | cost | max_tokens sent | thinking off |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const a of rows) {
      lines.push(`| \`${a.model}\` | ${a.ok}/${a.calls} | ${a.medianLatencyMs ?? "n/a"} ms | ${a.promptTokens} | ${a.completionTokens} | ${a.reasoningTokens} | ${a.truncations} | ${a.deadlineHits} | ${a.mathValid}/${a.mathTotal} | ${usd(a.costMicro)} | ${a.maxTokensSent} | ${a.thinkingSwitches ? "yes" : "no"} |`);
    }
    const errs = rows.filter((a) => Object.keys(a.errors).length);
    if (errs.length) {
      lines.push("", "Errors: " + errs.map((a) => `\`${a.model}\` ${Object.entries(a.errors).map(([k, v]) => `${k} x${v}`).join(", ")}`).join("; "));
    }
    lines.push("");
  }
  lines.push("## Settings that worked", "");
  for (const a of aggs.filter((x) => x.ok > 0 && x.truncations === 0)) lines.push(`- ${a.task} / \`${a.model}\`: max_tokens ${a.maxTokensSent}${a.thinkingSwitches ? ", enable_thinking false + reasoning_effort low" : ""}; no length stops in ${a.calls} calls.`);
  lines.push("", "## Pages", "");
  for (const [id, p] of Object.entries(input.pages)) lines.push(`- ${id}: ${p.width}x${p.height} px at ${p.dpi} dpi, ${p.bytes} bytes. ${p.why}.`);
  if (input.notes.length) lines.push("", "## Notes", "", ...input.notes.map((n) => `- ${n}`));
  lines.push("");
  return { json: { generatedAt: input.generatedAt, recommendation, exclusions: exclude, aggregates: aggs, records: input.records, quota: { before: input.quotaBefore, after: input.quotaAfter, deltaMicro: quotaDelta }, spentMicro: input.spentMicro, budgetMicrodollars: input.budgetMicrodollars, menus: input.menus, pages: input.pages, notes: input.notes }, markdown: lines.join("\n") };
}

export const htmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
