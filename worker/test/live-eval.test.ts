import { describe, expect, it } from "vitest";
import {
  aggregate, budgetAllows, buildReport, candidates, costMicro, damageFormula, exclusions, hasFence, htmlStructure, isRefusal, languageScore,
  leaksReasoning, markdownStructure, mathElements, mathmlWellFormed, parseArgs, pickRepairSource, planCall, rankModels, redact, scoreMath,
  strippedBySanitizer, texFragments, texParses, usageNumbers, type CallRecord, type Pricing,
} from "../scripts/live-eval-core";
import { optionsFrom } from "../src/models";
import { chatRequestBody } from "../src/gateway";
import { ocrTask, pageHtmlTask, parsePageHtml } from "../src/task-specs";
import { sanitizeHtml } from "../src/sanitize/html";
import { CATALOG } from "./catalog.fixture";

const catalog = optionsFrom(CATALOG.data as never);
const prices = new Map<string, Pricing>([["vision-plain", { input: 0.1, output: 0.3 }], ["vision-thinker", { input: 0.5, output: 2 }], ["vision-thinker-advanced", { input: 0.2, output: 0.6 }]]);

describe("arguments and the key", () => {
  it("parses flags with defaults: all tasks, $1.50 worst-case budget", () => {
    expect(parseArgs([])).toMatchObject({ dryRun: false, budgetMicrodollars: 1_500_000, budgetMode: "worst", tasks: ["ocr", "html", "math", "summary", "translate", "repair"], models: null, pages: null });
    expect(parseArgs(["--dry-run", "--tasks", "ocr,math", "--models=a,b", "--pages", "ch7-p2", "--budget-microdollars", "250000"])).toMatchObject({ dryRun: true, tasks: ["ocr", "math"], models: ["a", "b"], pages: ["ch7-p2"], budgetMicrodollars: 250000 });
  });
  it("refuses a key on the command line and rejects nonsense", () => {
    expect(() => parseArgs(["sk-cail-abcdefghijklmnopqrstuvwxyz"])).toThrow(/stdin/);
    expect(() => parseArgs(["--models", "sk-cail-0123456789abcdef0123"])).toThrow(/stdin/);
    expect(() => parseArgs(["--tasks", "ocr,fly"])).toThrow(/unknown task/);
    expect(() => parseArgs(["--budget-microdollars", "-3"])).toThrow();
    expect(() => parseArgs(["--key", "x"])).toThrow(/unknown argument/);
  });
  it("redacts the key and its bearer form from any text", () => {
    const key = "sk-cail-SECRETSECRETSECRET";
    expect(redact(`Authorization: Bearer ${key}; also ${key}`, key)).toBe("Authorization: Bearer [redacted]; also [redacted]");
    expect(redact("nothing here", key)).toBe("nothing here");
  });
});

describe("plan: the Worker's own menus, budgets and reasoning controls", () => {
  it("vision tasks compare every recommended vision model, default first", () => {
    const ocr = candidates("ocr", catalog, prices, null);
    expect(ocr.default?.id).toBe("vision-plain");
    expect(ocr.menu.map((m) => m.id)).toEqual(["vision-plain", "vision-thinker", "vision-thinker-advanced"]);
    expect(ocr.run.map((m) => m.id)).toEqual(["vision-plain", "vision-thinker"]);
  });
  it("the math path runs every vision+reasoning model, recommended first, then cheapest", () => {
    const math = candidates("math", catalog, prices, null);
    expect(math.default?.id).toBe("vision-thinker");
    expect(math.run.map((m) => m.id)).toEqual(["vision-thinker", "vision-thinker-advanced"]);
    expect(candidates("math", catalog, prices, ["vision-thinker-advanced"]).run.map((m) => m.id)).toEqual(["vision-thinker-advanced"]);
  });
  it("token budgets and thinking switches are the Worker's", () => {
    const thinker = catalog.find((m) => m.id === "vision-thinker")!;
    const plain = catalog.find((m) => m.id === "vision-plain")!;
    expect(planCall(1, "ocr", "p", thinker, true, 2000, null)).toMatchObject({ maxTokens: 4096, headroom: 4000, switches: true });
    expect(planCall(1, "math", "p", thinker, true, 2000, null)).toMatchObject({ maxTokens: 6000, headroom: 8000, switches: false });
    expect(planCall(1, "html", "p", plain, true, 2000, null)).toMatchObject({ maxTokens: 6000, headroom: 0, switches: false });
    // ...and match the exact body the Worker sends.
    const body = chatRequestBody(pageHtmlTask(thinker, { imageDataUri: "data:image/jpeg;base64,AA", pageNumber: 2, totalPages: null, hint: "", math: true }));
    expect(body).toMatchObject({ model: "vision-thinker", max_tokens: 14000, stream: false });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(chatRequestBody(ocrTask(thinker, "data:image/jpeg;base64,AA"))).toMatchObject({ max_tokens: 8096, reasoning_effort: "low", chat_template_kwargs: { enable_thinking: false } });
  });
  it("cost: catalog prices are microdollars per token", () => {
    expect(costMicro(1000, 2000, { input: 0.3, output: 1.2 })).toBe(2700);
    expect(costMicro(null, 5, { input: 1, output: 1 })).toBeNull();
    expect(costMicro(1, 1, null)).toBeNull();
  });
  it("the budget stops a call BEFORE it could cross the cap", () => {
    const call = planCall(1, "ocr", "p", catalog.find((m) => m.id === "vision-plain")!, true, 2000, { input: 0.1, output: 0.3 });
    expect(call.worstMicro).toBe(Math.round(2000 * 0.1 + 4096 * 0.3));
    expect(budgetAllows(0, call, 1429, "worst")).toBe(true);
    expect(budgetAllows(1, call, 1429, "worst")).toBe(false);
    expect(budgetAllows(1, call, 1429, "expected")).toBe(true);
    const unpriced = planCall(2, "ocr", "p", catalog.find((m) => m.id === "vision-plain")!, true, 2000, null);
    expect(budgetAllows(0, unpriced, 10_000, "worst")).toBe(false); // unknown price is assumed to be the dearest
  });
});

describe("scoring", () => {
  it("finds TeX in every delimiter the app renders and checks each with temml", () => {
    const html = "<p>\\(x^2\\) and \\[\\frac{a}{b}\\] and \\(\\frac{1}{\\)</p>";
    expect(texFragments(html).map((f) => f.delimiter)).toEqual(["\\[", "\\(", "\\("]);
    expect(scoreMath(html)).toMatchObject({ total: 3, valid: 2, tex: 3, texValid: 2 });
    expect(texFragments("cost $5 and $x^2$ here", true).map((f) => f.tex)).toEqual(["x^2"]);
    expect(texParses("\\sqrt{41}")).toBe(true);
    expect(texParses("\\sqrt{41")).toBe(false);
  });
  it("checks MathML elements for balance, content and merror", () => {
    expect(mathElements('<p><math><mi>x</mi></math> and <math display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac></math></p>')).toHaveLength(2);
    expect(mathmlWellFormed("<math><mrow><mi>x</mi></mrow></math>")).toBe(true);
    expect(mathmlWellFormed("<math><mrow><mi>x</mi></math>")).toBe(false);
    expect(mathmlWellFormed("<math><merror><mtext>bad</mtext></merror></math>")).toBe(false);
    expect(mathmlWellFormed("<math></math>")).toBe(false);
  });
  it("reports exactly what the real sanitizer stripped", () => {
    const raw = '<section data-page="1"><p style="color:red" onclick="x()">Hi</p><script>alert(1)</script><table><tr><td>1</td></tr></table></section>';
    const diff = strippedBySanitizer(raw, sanitizeHtml(raw));
    expect(diff.tags).toEqual({ script: 1 });
    expect(diff.attrs).toEqual({ style: 1, onclick: 1 });
    expect(diff.intact).toBe(false);
    const clean = parsePageHtml('<section data-page="3"><h2>T</h2><p>\\(x\\)</p></section>', 3);
    expect(strippedBySanitizer(clean.unsanitized, clean.html).intact).toBe(true);
  });
  it("structure, fences, refusals, leaked reasoning and language", () => {
    expect(htmlStructure("<h2>a</h2><table></table><ul><li>x</li></ul><section></section>")).toMatchObject({ headings: 1, tables: 1, lists: 1, sections: 1 });
    expect(markdownStructure("## Title\n\n| a | b |\n| --- | --- |\n- item\n\n---\n")).toMatchObject({ headings: 1, tables: 1, lists: 1, sections: 1 });
    expect(hasFence("```html\n<p>")).toBe(true);
    expect(isRefusal("I'm sorry, but I can't help with that.")).toBe(true);
    expect(isRefusal("Solve for x.")).toBe(false);
    expect(leaksReasoning("<think>hmm</think>ok")).toBe(true);
    expect(languageScore("il seno e il coseno della funzione sono periodici con una frequenza", "it")).toBeGreaterThan(0.25);
    expect(languageScore("il seno e il coseno della funzione", "es")).toBeLessThan(0.2);
  });
  it("damages a real formula so it no longer parses, and picks one from model output", () => {
    const broken = damageFormula("\\frac{-3+\\sqrt{41}}{8}")!;
    expect(broken).not.toBe("\\frac{-3+\\sqrt{41}}{8}");
    expect(texParses(broken)).toBe(false);
    expect(pickRepairSource(['<p>\\(x\\) and \\[\\cos(\\theta)=\\frac{-3+\\sqrt{41}}{8}\\]</p>'])).toBe("\\cos(\\theta)=\\frac{-3+\\sqrt{41}}{8}");
    expect(pickRepairSource(["<p>no math</p>"])).toBeNull();
  });
  it("reads reasoning tokens and any reported cost from usage", () => {
    expect(usageNumbers({ prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 }, cail_provider: "workers-ai" })).toEqual({ prompt: 10, completion: 30, reasoning: 20, reportedCostMicro: null });
    expect(usageNumbers({ input_tokens: 1, output_tokens: 2, cost: 0.0015 })).toEqual({ prompt: 1, completion: 2, reasoning: null, reportedCostMicro: 1500 });
    expect(usageNumbers(null)).toEqual({ prompt: null, completion: null, reasoning: null, reportedCostMicro: null });
  });
});

describe("report", () => {
  const rec = (over: Partial<CallRecord>): CallRecord => ({
    n: 1, task: "math", page: "p", model: "m", isDefault: false, reasoning: true, ok: true, status: 200, errorCode: null, finishReason: "stop",
    promptTokens: 100, completionTokens: 200, reasoningTokens: 50, usage: null, provider: null, latencyMs: 1000, deadlineHit: false, outputChars: 10,
    maxTokensSent: 14000, thinkingSwitches: false, imageBytes: 1, costMicro: 500, costSource: "catalog", quality: {}, mathTotal: 10, mathValid: 9, ...over,
  });
  const records = [
    rec({ model: "good" }), rec({ model: "good", latencyMs: 3000 }),
    rec({ model: "bad", ok: false, errorCode: "model_output_empty", finishReason: "length", mathTotal: 0, mathValid: 0 }), rec({ model: "bad", ok: false, errorCode: "model_output_empty", finishReason: "length", mathTotal: 0, mathValid: 0 }),
    rec({ model: "sloppy", mathValid: 2 }),
  ];
  it("aggregates per task and model, ranks, and names exclusions", () => {
    const aggs = aggregate(records);
    const good = aggs.find((a) => a.model === "good")!;
    expect(good).toMatchObject({ calls: 2, ok: 2, okRate: 1, medianLatencyMs: 2000, mathValid: 18, mathTotal: 20, costMicro: 1000, truncations: 0 });
    expect(rankModels(aggs, "math").map((a) => a.model)).toEqual(["good", "sloppy"]);
    expect(exclusions(aggs, records)).toEqual([{ task: "math", model: "bad", reason: "no successful call (model_output_empty x2)" }]);
  });
  it("writes the recommendation, the quota difference and a table per task", () => {
    const { json, markdown } = buildReport({ generatedAt: "2026-11-10T00:00:00Z", records, quotaBefore: { limit: 10_000_000, estimated_used: 100_000 }, quotaAfter: { limit: 10_000_000, estimated_used: 103_500 }, budgetMicrodollars: 1_500_000, spentMicro: 3500, stoppedByBudget: 0, menus: { math: { default: "good", menu: ["good", "bad", "sloppy"], run: ["good", "bad", "sloppy"] } }, pages: {}, notes: [] });
    expect(markdown).toContain("Default math/tables model: **good**");
    expect(markdown).toContain("difference $0.0035");
    expect(markdown).toContain("| `bad` | 0/2 |");
    expect(markdown).toContain("`bad`: no successful call");
    expect((json as { quota: { deltaMicro: number } }).quota.deltaMicro).toBe(3500);
  });
});
