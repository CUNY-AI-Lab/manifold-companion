import { describe, expect, it } from "vitest";
import { BUILTIN_POLICY, defaultFor, offeredMenu, optionsFrom, policyFrom, resolveModel, thinksOnMath } from "../src/models";
import { chatRequestBody } from "../src/gateway";
import { pageHtmlTask } from "../src/task-specs";
import { ALICE, api, call, createProject, createText, json } from "./helpers";
import { chatBodies, gatewayEnv } from "./gateway-stub";
import type { Env } from "../src/env";

// Rows as in the live catalog on 2026-11-10 (ids, order, recommended, capabilities).
const row = (id: string, order: number, recommended: boolean, capabilities: string[]) => ({
  id, object: "model", recommended, tier: recommended ? "recommended" : "advanced", order, status: "active", modality: "text", provider: "workers-ai",
  upstream_model: id, pricing_known: "catalog", streaming: true, sunset: null, capabilities, context_length: 128000, registry_url: null, name: id, task: "Text Generation",
});
const V = ["text-generation", "vision"];
const VR = ["text-generation", "vision", "reasoning"];
const R = ["text-generation", "reasoning"];
const LIVE = [
  row("deepseek-v4.1-flash-1017", 1, true, VR), row("glm-5.3", 2, true, R), row("qwen3.8-27b", 3, true, VR), row("gpt-oss-120b", 4, true, R),
  row("gemma-4-26b-a4b-it", 5, true, VR), row("mistral-large-3-675b-instruct", 6, true, V), row("glm-5.3-flash", 23, false, VR),
  row("kimi-k2.6", 29, false, VR), row("kimi-k3", 31, false, VR), row("magistral-small-2509", 40, false, VR), row("llama-4-scout-17b-16e-instruct", 38, false, V),
];
const catalog = optionsFrom(LIVE as never);
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);
const env = (over: Partial<Env> = {}) => over as Env;

describe("model policy from the 2026-11-10 live evaluation", () => {
  const policy = policyFrom(env());
  it("defaults: DeepSeek Flash for OCR and page HTML, Magistral Small for math/tables", () => {
    expect(defaultFor("ocr", offeredMenu("ocr", catalog, policy), policy)?.id).toBe("deepseek-v4.1-flash-1017");
    expect(defaultFor("html_page", offeredMenu("html_page", catalog, policy), policy)?.id).toBe("deepseek-v4.1-flash-1017");
    expect(defaultFor("html_math", offeredMenu("html_math", catalog, policy), policy)?.id).toBe("magistral-small-2509");
    expect(defaultFor("text", offeredMenu("text", catalog, policy), policy)?.id).toBe("deepseek-v4.1-flash-1017");
  });
  it("the math menu offers only the models that passed, in evidence order; no Gemma, no Kimi", () => {
    expect(ids(offeredMenu("html_math", catalog, policy))).toEqual(["magistral-small-2509", "deepseek-v4.1-flash-1017", "qwen3.8-27b"]);
  });
  it("Kimi is offered nowhere by default; the standard vision menu puts the measured models first", () => {
    for (const task of ["ocr", "html_page", "html_math", "text"] as const) expect(ids(offeredMenu(task, catalog, policy)).some((id) => id.startsWith("kimi-"))).toBe(false);
    expect(ids(offeredMenu("ocr", catalog, policy)).slice(0, 4)).toEqual(["deepseek-v4.1-flash-1017", "mistral-large-3-675b-instruct", "qwen3.8-27b", "gemma-4-26b-a4b-it"]);
  });
  it("hidden models stay reachable by typing their id; uncapable ones do not", () => {
    expect(resolveModel("html_math", catalog, env(), "kimi-k3").id).toBe("kimi-k3");
    expect(resolveModel("html_math", catalog, env(), "gemma-4-26b-a4b-it").id).toBe("gemma-4-26b-a4b-it");
    expect(() => resolveModel("html_math", catalog, env(), "glm-5.3")).toThrow(/not offered/); // no vision
  });
  it("a retired or renamed model degrades to the next measured one, then to the catalog rule", () => {
    const noMagistral = catalog.filter((m) => m.id !== "magistral-small-2509");
    expect(resolveModel("html_math", noMagistral, env()).id).toBe("deepseek-v4.1-flash-1017");
    const noneMeasured = catalog.filter((m) => !BUILTIN_POLICY.mathOffered.includes(m.id));
    expect(ids(offeredMenu("html_math", noneMeasured, policy))).toEqual(["glm-5.3-flash"]); // vision+reasoning, minus Gemma and Kimi
    const noDeepseek = catalog.filter((m) => m.id !== "deepseek-v4.1-flash-1017");
    expect(resolveModel("ocr", noDeepseek, env()).id).toBe("mistral-large-3-675b-instruct");
  });
  it("vars override every list; DEFAULT_*_MODEL pins first place", () => {
    const p = policyFrom(env({ MATH_MODELS_OFFERED: "qwen3.8-27b, magistral-small-2509", MODELS_HIDDEN: "", MATH_MODELS_HIDDEN: "", DEFAULT_MATH_MODEL: "qwen3.8-27b" }));
    expect(ids(offeredMenu("html_math", catalog, p))).toEqual(["qwen3.8-27b", "magistral-small-2509"]);
    expect(defaultFor("html_math", offeredMenu("html_math", catalog, p), p)?.id).toBe("qwen3.8-27b");
    expect(ids(offeredMenu("ocr", catalog, p))).toContain("kimi-k3");
    expect(policyFrom(env({ MODELS_HIDDEN: "bad id;drop table, kimi-*" })).hidden).toEqual(["kimi-*"]);
  });
  it("DeepSeek thinks with the switches off on the math path (it reasoned past 14,000 tokens on a tables page); Magistral thinks as measured", () => {
    const deepseek = catalog.find((m) => m.id === "deepseek-v4.1-flash-1017")!;
    const magistral = catalog.find((m) => m.id === "magistral-small-2509")!;
    expect(thinksOnMath(deepseek, policy)).toBe(false);
    expect(thinksOnMath(magistral, policy)).toBe(true);
    const input = { imageDataUri: "data:image/jpeg;base64,AA", pageNumber: 19, totalPages: null, hint: "", math: true };
    expect(chatRequestBody(pageHtmlTask(deepseek, { ...input, thinking: thinksOnMath(deepseek, policy) }))).toMatchObject({ max_tokens: 10000, reasoning_effort: "low", chat_template_kwargs: { enable_thinking: false } });
    const m = chatRequestBody(pageHtmlTask(magistral, { ...input, thinking: thinksOnMath(magistral, policy) }));
    expect(m.max_tokens).toBe(14000);
    expect(m).not.toHaveProperty("reasoning_effort");
  });
});

describe("through the routes", () => {
  it("GET /models shows the offered menus, defaults and how many more models can be typed", async () => {
    const e = await gatewayEnv({ catalog: () => Response.json({ object: "list", data: LIVE }) });
    const { tasks } = await json(await call(api("/models"), { env: e }));
    expect(tasks.html_math).toMatchObject({ default: "magistral-small-2509", typeable: 4 });
    expect(ids(tasks.html_math.models)).toEqual(["magistral-small-2509", "deepseek-v4.1-flash-1017", "qwen3.8-27b"]);
    expect(tasks.ocr.default).toBe("deepseek-v4.1-flash-1017");
  });
  it("a math page with no model chosen goes to Magistral; DeepSeek chosen for math gets the thinking-off switches", async () => {
    const e = await gatewayEnv({ catalog: () => Response.json({ object: "list", data: LIVE }), chat: () => ({ text: '<section data-page="1"><p>\\(x\\)</p></section>' }) });
    const project = await createProject(ALICE, "P", { project_type: "pdf_to_html" });
    const tid = await createText(ALICE, project);
    const IMG = "data:image/png;base64,iVBORw0KGgo=";
    await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: IMG, page_number: 1, math: true }, env: e });
    await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: IMG, page_number: 1, math: true, model: "deepseek-v4.1-flash-1017" }, env: e });
    const [first, second] = await chatBodies(e);
    expect(first).toMatchObject({ model: "magistral-small-2509", max_tokens: 14000 });
    expect(first).not.toHaveProperty("reasoning_effort");
    expect(second).toMatchObject({ model: "deepseek-v4.1-flash-1017", max_tokens: 10000, reasoning_effort: "low" });
  });
});
