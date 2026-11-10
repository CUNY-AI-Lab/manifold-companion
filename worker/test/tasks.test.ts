import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cailErrorEnvelope, cailErrorResponse, quotaExceededResponse, quotaSnapshotBody } from "@cuny-ai-lab/cail-client/testing";
import { ALICE, BOB, JPEG, addMember, api, call, createProject, createText, json, legs, upload } from "./helpers";
import { chatBodies, chatCalls, gatewayEnv, gatewayOf } from "./gateway-stub";
import { REASONING_HEADROOM, REASONING_WANTED_HEADROOM } from "../src/models";
import type { Env } from "../src/env";

// Real: Hono app, CAIL Identity verification with a real signing key, the CAIL
// Client and its error/quota parsers, D1 and R2 (Miniflare). Substituted: the
// GATEWAY service binding only. Nothing here proves a live Gateway call.

async function imagePage(as = ALICE, e?: Env) {
  const pid = await createProject(as);
  const tid = await createText(as, pid);
  const res = await upload(api(`/texts/${tid}/pages`), JPEG(256), as, { query: { filename: "p1.jpg" }, ...(e ? { env: e } : {}) });
  const page = (await json(res)).page;
  return { pid, tid, pageId: page.id as string };
}
async function pdfText(as = ALICE) {
  const pid = await createProject(as, "PDF", { project_type: "pdf_to_html" });
  const tid = await createText(as, pid);
  return { pid, tid };
}
const ocr = (tid: string, pageId: string, e: Env, body: unknown = {}, extra: { as?: string; headers?: Record<string, string> } = {}) =>
  call(api(`/texts/${tid}/pages/${pageId}/ocr`), { method: "POST", body, env: e, ...extra });
const pageText = async (pageId: string) => (await env.DB.prepare("SELECT ocr_text, ocr_model FROM pages WHERE id = ?").bind(pageId).first<{ ocr_text: string | null; ocr_model: string | null }>())!;
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

describe("Gateway transport", () => {
  it("OCR makes ONE call with the Gateway leg only, the app header, a fresh request id, and an image_url data URI", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "Transcribed page" }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    const headers = await legs(ALICE);
    const inboundId = "0190a0b4-8c5e-7cc4-9a7e-6f3f2b4b1a11";
    const res = await call(api(`/texts/${tid}/pages/${pageId}/ocr`), { method: "POST", body: {}, env: e, as: null, headers: { ...headers, "x-cail-request-id": inboundId } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ text: "Transcribed page", model: "vision-plain" });
    const calls = chatCalls(e);
    expect(calls).toHaveLength(1);
    const call0 = calls[0]!;
    expect(new URL(call0.url).pathname).toBe("/v1/chat/completions");
    expect(call0.headers.get("x-cail-identity-jwt")).toBe(headers["x-cail-gateway-identity-jwt"]);
    expect(call0.headers.get("x-cail-identity-jwt")).not.toBe(headers["x-cail-identity-jwt"]);
    expect(call0.headers.get("authorization")).toBeNull();
    expect(call0.headers.get("x-cail-gateway-identity-jwt")).toBeNull();
    expect(call0.headers.get("x-cail-app")).toBe("manifold-companion");
    const outboundId = call0.headers.get("x-cail-request-id");
    expect(outboundId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(outboundId).not.toBe(inboundId);
    expect(res.headers.get("x-cail-request-id")).toBe(inboundId);
    const [sent] = await chatBodies(e);
    const parts = sent.messages[0].content as { type: string; image_url?: { url: string } }[];
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(parts[1]!.image_url!.url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    expect(JSON.stringify(sent)).not.toMatch(/"type":"file"|application\/pdf|input_file/);
    expect(sent.stream).toBe(false);
    expect(await pageText(pageId)).toEqual({ ocr_text: "Transcribed page", ocr_model: "vision-plain" });
  });

  it("each outbound call gets its own request id (catalog and chat differ)", async () => {
    const e = await gatewayEnv();
    const { tid, pageId } = await imagePage(ALICE, e);
    await ocr(tid, pageId, e);
    const ids = gatewayOf(e).calls.map((r) => r.headers.get("x-cail-request-id"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("the catalog is cached per isolate: two tasks, one catalog read", async () => {
    const e = await gatewayEnv();
    const { tid, pageId } = await imagePage(ALICE, e);
    await ocr(tid, pageId, e);
    await ocr(tid, pageId, e, { overwrite: true });
    expect(gatewayOf(e).calls.filter((r) => new URL(r.url).pathname === "/v1/catalog")).toHaveLength(1);
    expect(chatCalls(e)).toHaveLength(2);
  });

  it("passes the Gateway's safe error through: code, message, x-should-retry and Retry-After, with no retry", async () => {
    const e = await gatewayEnv({ chat: () => ({ response: cailErrorResponse(503, cailErrorEnvelope({ code: "upstream_unavailable", message: "The model provider is busy.", type: "server_error" }), { "x-should-retry": "true", "retry-after": "7" }) }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    const res = await ocr(tid, pageId, e);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-should-retry")).toBe("true");
    expect(res.headers.get("retry-after")).toBe("7");
    expect((await json(res)).error).toMatchObject({ code: "upstream_unavailable", message: "The model provider is busy.", retryable: true });
    expect(chatCalls(e)).toHaveLength(1);
    expect((await pageText(pageId)).ocr_text).toBeNull();
  });

  it("quota exhaustion is non-retryable quota_exceeded", async () => {
    const e = await gatewayEnv({ chat: () => ({ response: quotaExceededResponse({ retryAfterSeconds: 3600 }) }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    const res = await ocr(tid, pageId, e);
    expect(res.status).toBe(429);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect((await json(res)).error).toMatchObject({ code: "quota_exceeded", retryable: false });
    expect(chatCalls(e)).toHaveLength(1);
  });

  it("a transport failure is an ambiguous outcome: not retryable, and the exception text never leaks", async () => {
    const e = await gatewayEnv({ chat: () => { throw new TypeError("network lost"); } });
    const { tid, pageId } = await imagePage(ALICE, e);
    const res = await ocr(tid, pageId, e);
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error).toMatchObject({ code: "network_error", retryable: false });
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(JSON.stringify(body)).not.toContain("network lost");
  });

  it("cancellation: the inbound request's signal aborts the Gateway call", async () => {
    let sawAbort = false;
    const e = await gatewayEnv({
      chat: (_body, request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => { sawAbort = true; reject(request.signal.reason); });
      }),
    });
    const { tid, pageId } = await imagePage(ALICE, e);
    const controller = new AbortController();
    const headers = { ...(await legs(ALICE)), origin: "https://tools.ailab.gc.cuny.edu", "content-type": "application/json" };
    const pending = (await import("../src/app")).default.fetch(new Request(`https://tools.ailab.gc.cuny.edu${api(`/texts/${tid}/pages/${pageId}/ocr`)}`, { method: "POST", headers, body: "{}", signal: controller.signal }), e);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const res = await pending;
    expect(sawAbort).toBe(true);
    expect(res.status).toBe(499);
    expect((await json(res)).error.code).toBe("client_closed_request");
    expect((await pageText(pageId)).ocr_text).toBeNull();
  });

  it("deadline: a model that never answers is cut off with model_deadline_exceeded", async () => {
    const e = await gatewayEnv({ chat: (_b, request) => new Promise((_r, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))) }, { MODEL_DEADLINE_MS: "80" });
    const { tid, pageId } = await imagePage(ALICE, e);
    const res = await ocr(tid, pageId, e);
    expect(res.status).toBe(504);
    expect((await json(res)).error).toMatchObject({ code: "model_deadline_exceeded", retryable: false });
  });
});

describe("output limits and reasoning headroom", () => {
  it("an empty reply with finish_reason length is model_output_empty; nothing is stored", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "", finish_reason: "length" }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    const res = await ocr(tid, pageId, e, { model: "vision-thinker" });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("model_output_empty");
    expect((await pageText(pageId)).ocr_text).toBeNull();
  });

  it("a reasoning-only reply cut by length also counts as empty", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "<think>still thinking about the page", finish_reason: "length" }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    expect((await json(await ocr(tid, pageId, e, { model: "vision-thinker" }))).error.code).toBe("model_output_empty");
  });

  it("a partial reply cut by length is model_output_truncated and discarded", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "First half of the pa", finish_reason: "length" }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    const res = await ocr(tid, pageId, e);
    expect((await json(res)).error.code).toBe("model_output_truncated");
    expect((await pageText(pageId)).ocr_text).toBeNull();
  });

  it("a reasoning model gets headroom and the thinking switches; a plain model gets neither", async () => {
    const e = await gatewayEnv();
    const { tid, pageId } = await imagePage(ALICE, e);
    await ocr(tid, pageId, e, { model: "vision-thinker" });
    await ocr(tid, pageId, e, { model: "vision-plain", overwrite: true });
    const [thinker, plain] = await chatBodies(e);
    expect(thinker.max_tokens).toBe(4096 + REASONING_HEADROOM);
    expect(thinker.reasoning_effort).toBe("low");
    expect(thinker.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(plain.max_tokens).toBe(4096);
    expect(plain).not.toHaveProperty("reasoning_effort");
    expect(plain).not.toHaveProperty("chat_template_kwargs");
  });
});

describe("model choice is the live catalog, by capability", () => {
  it("GET /models: menus per task, Gateway order, speech and retiring rows excluded, math prefers vision+reasoning", async () => {
    const e = await gatewayEnv();
    const { tasks } = await json(await call(api("/models"), { env: e }));
    expect(tasks.text.models.map((m: any) => m.id)).toEqual(["text-only-fast", "vision-plain", "vision-thinker", "text-thinker", "vision-thinker-advanced"]);
    expect(tasks.ocr.models.map((m: any) => m.id)).toEqual(["vision-plain", "vision-thinker", "vision-thinker-advanced"]);
    expect(tasks.html_math.models.map((m: any) => m.id)).toEqual(["vision-thinker", "vision-thinker-advanced"]);
    expect(tasks.ocr.default).toBe("vision-plain");
    expect(tasks.html_math.default).toBe("vision-thinker");
    expect(JSON.stringify(tasks)).not.toMatch(/speech|retired-vision/);
  });

  it("a model not on the task's menu is model_not_allowed before any spend; a text-only model cannot do OCR", async () => {
    const e = await gatewayEnv();
    const { tid, pageId } = await imagePage(ALICE, e);
    for (const model of ["not-in-catalog", "text-only-fast", "retired-vision", "speech"]) {
      const res = await ocr(tid, pageId, e, { model });
      expect(res.status, model).toBe(400);
      expect((await json(res)).error.code, model).toBe("model_not_allowed");
    }
    expect(chatCalls(e)).toHaveLength(0);
  });

  it("a stale saved setting is refused the same way rather than silently replaced", async () => {
    const e = await gatewayEnv();
    const { tid, pageId } = await imagePage(ALICE, e);
    await call(api(`/texts/${tid}/settings`), { method: "POST", body: { model: "gone-model" }, env: e });
    expect((await json(await ocr(tid, pageId, e))).error.code).toBe("model_not_allowed");
    expect(chatCalls(e)).toHaveLength(0);
  });

  it("fails closed when the catalog is down: no hard-coded fallback model", async () => {
    const e = await gatewayEnv({ catalog: () => new Response("down", { status: 503 }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    const res = await ocr(tid, pageId, e);
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("catalog_unavailable");
    expect(chatCalls(e)).toHaveLength(0);
  });

  it("GET /quota is the Gateway's own snapshot, read with the Gateway leg", async () => {
    const snapshot = quotaSnapshotBody();
    const e = await gatewayEnv({ quota: () => Response.json(snapshot) });
    const headers = await legs(ALICE);
    const res = await call(api("/quota"), { env: e, as: null, headers });
    expect(res.status).toBe(200);
    expect((await json(res)).quota).toEqual(snapshot);
    const q = gatewayOf(e).calls.find((r) => new URL(r.url).pathname === "/v1/quota")!;
    expect(q.headers.get("x-cail-identity-jwt")).toBe(headers["x-cail-gateway-identity-jwt"]);
  });

  it("GET /quota passes quota_unavailable through as retryable 503", async () => {
    const e = await gatewayEnv({ quota: () => cailErrorResponse(503, cailErrorEnvelope({ code: "quota_unavailable", message: "Usage is not available right now.", type: "server_error" }), { "x-should-retry": "true" }) });
    const res = await call(api("/quota"), { env: e });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toMatchObject({ code: "quota_unavailable", retryable: true });
  });
});

describe("OCR never overwrites corrected text silently", () => {
  it("refuses to replace existing text without overwrite, before any spend", async () => {
    const e = await gatewayEnv();
    const { tid, pageId } = await imagePage(ALICE, e);
    await call(api(`/texts/${tid}/pages/${pageId}`), { method: "POST", body: { text: "Hand-corrected." }, env: e });
    const res = await ocr(tid, pageId, e);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("page_has_text");
    expect(chatCalls(e)).toHaveLength(0);
  });

  it("with overwrite, the corrected text is saved as a page version first", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "Fresh model text" }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    await call(api(`/texts/${tid}/pages/${pageId}`), { method: "POST", body: { text: "Hand-corrected." }, env: e });
    expect((await ocr(tid, pageId, e, { overwrite: true })).status).toBe(200);
    expect((await pageText(pageId)).ocr_text).toBe("Fresh model text");
    const { versions } = await json(await call(api(`/texts/${tid}/versions?type=page`), { env: e }));
    expect(versions).toHaveLength(1);
    const v = await json(await call(api(`/texts/${tid}/versions/${versions[0].id}`), { env: e }));
    expect(v.version.content).toBe("Hand-corrected.");
  });

  it("an edit made while the model was reading wins; the paid result is returned for comparison", async () => {
    let tidRef = "";
    let pageRef = "";
    const e = await gatewayEnv({
      chat: async () => {
        await call(api(`/texts/${tidRef}/pages/${pageRef}`), { method: "POST", body: { text: "Edited meanwhile" }, env: e });
        return { text: "Model text" };
      },
    });
    const { tid, pageId } = await imagePage(ALICE, e);
    tidRef = tid;
    pageRef = pageId;
    const res = await ocr(tid, pageId, e);
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe("edit_conflict");
    expect(body.result).toEqual({ text: "Model text", model: "vision-plain" });
    expect((await pageText(pageId)).ocr_text).toBe("Edited meanwhile");
  });

  it("a viewer cannot spend through the editor's text; OCR needs an image project", async () => {
    const e = await gatewayEnv();
    const { pid, tid, pageId } = await imagePage(ALICE, e);
    await addMember(ALICE, pid, BOB, "viewer");
    expect((await ocr(tid, pageId, e, {}, { as: BOB })).status).toBe(403);
    const pdf = await pdfText();
    expect((await call(api(`/texts/${pdf.tid}/parse-page`), { method: "POST", body: { image: IMG, page_number: 1 }, env: e, as: BOB })).status).toBe(404);
    expect(chatCalls(e)).toHaveLength(0);
  });
});

describe("page image to structured HTML (PDF-to-HTML), with the separate math model", () => {
  it("non-math pages use the vision model, math pages the math model with thinking left on", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: '<section data-page="2"><h2>Theorem</h2><p>\\(x^2\\) holds.</p></section>' }) });
    const { tid } = await pdfText();
    await call(api(`/texts/${tid}/settings`), { method: "POST", body: { math_model: "vision-thinker-advanced" }, env: e });
    const plain = await json(await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: IMG, page_number: 2 }, env: e }));
    const math = await json(await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: IMG, page_number: 2, math: true, text_hint: "Theorem x squared holds for all real x" }, env: e }));
    expect(plain).toMatchObject({ model: "vision-plain", math: false });
    expect(math).toMatchObject({ model: "vision-thinker-advanced", math: true });
    expect(math.html).toContain("\\(x^2\\)");
    const [p, m] = await chatBodies(e);
    expect(p.model).toBe("vision-plain");
    expect(m.model).toBe("vision-thinker-advanced");
    expect(m.max_tokens).toBe(6000 + REASONING_WANTED_HEADROOM);
    expect(m).not.toHaveProperty("reasoning_effort");
    expect(m.messages[1].content[0].text).toContain("Extracted text layer");
    expect(m.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: IMG } });
  });

  it("a math request refuses a model that is not vision-capable", async () => {
    const e = await gatewayEnv();
    const { tid } = await pdfText();
    const res = await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: IMG, page_number: 1, math: true, model: "text-thinker" }, env: e });
    expect((await json(res)).error.code).toBe("model_not_allowed");
  });

  it("hostile model output is sanitized before it is returned; MathML survives", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: '```html\n<section data-page="1"><p onclick="x()">Hi <a href="javascript:alert(1)">l</a></p><script>alert(1)</script><img src=x onerror=alert(1)><math><mi>x</mi></math></section>\n```' }) });
    const { tid } = await pdfText();
    const { html } = await json(await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: IMG, page_number: 1 }, env: e }));
    expect(html).not.toMatch(/onclick|javascript|<script|onerror/);
    expect(html).toContain('<section data-page="1">');
    expect(html).toContain("<math><mi>x</mi></math>");
  });

  it("only page images go to the model: PDFs, non-image data URIs and oversized images are refused before any call", async () => {
    const e = await gatewayEnv();
    const { tid } = await pdfText();
    for (const image of ["data:application/pdf;base64,JVBERi0xLjc=", "data:image/svg+xml;base64,PHN2Zz4=", "https://example.org/p.png", 5]) {
      const res = await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image, page_number: 1 }, env: e });
      expect(res.status, String(image)).toBe(400);
    }
    const big = `data:image/jpeg;base64,${"A".repeat(5_700_000)}`;
    expect((await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: big, page_number: 1 }, env: e })).status).toBe(413);
    expect(chatCalls(e)).toHaveLength(0);
  });

  it("figures named in the request must exist for the text", async () => {
    const e = await gatewayEnv();
    const { tid } = await pdfText();
    const res = await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: IMG, page_number: 1, figures: ["ghost.png"] }, env: e });
    expect((await json(res)).error.code).toBe("figure_unknown");
    expect(chatCalls(e)).toHaveLength(0);
  });
});

describe("summary, translation chunk, formula repair", () => {
  it("summary is generated from the page text, stored in D1 (bounded) and indexed", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "<think>hmm</think>A short summary." }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    await call(api(`/texts/${tid}/pages/${pageId}`), { method: "POST", body: { text: "Once upon a time." }, env: e });
    const res = await json(await call(api(`/texts/${tid}/summary`), { method: "POST", body: {}, env: e }));
    expect(res.summary).toBe("A short summary.");
    expect((await json(await call(api(`/texts/${tid}/summary`), { env: e }))).summary).toBe("A short summary.");
    const [sent] = await chatBodies(e);
    expect(sent.messages[1].content).toContain("Once upon a time.");
  });

  it("summary with no text yet is refused before any call", async () => {
    const e = await gatewayEnv();
    const { tid } = await imagePage(ALICE, e);
    expect((await json(await call(api(`/texts/${tid}/summary`), { method: "POST", body: {}, env: e }))).error.code).toBe("no_text");
    expect(chatCalls(e)).toHaveLength(0);
  });

  it("translation is one bounded chunk per request; the client stores the assembled result", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "Hello." }) });
    const { tid } = await imagePage(ALICE, e);
    const ok = await json(await call(api(`/texts/${tid}/translate-chunk`), { method: "POST", body: { text: "Hola.", source_language: "es", target_language: "en" }, env: e }));
    expect(ok.text).toBe("Hello.");
    const big = await call(api(`/texts/${tid}/translate-chunk`), { method: "POST", body: { text: "x".repeat(12_001), source_language: "es", target_language: "en" }, env: e });
    expect((await json(big)).error.code).toBe("chunk_too_large");
    expect((await call(api(`/texts/${tid}/translate-chunk`), { method: "POST", body: { text: "x", source_language: "es", target_language: "auto-detect" }, env: e })).status).toBe(400);
    expect(chatCalls(e)).toHaveLength(1);
    expect((await call(api(`/texts/${tid}/translation`), { method: "PUT", body: { translation: "Hello." }, env: e })).status).toBe(200);
    expect((await json(await call(api(`/texts/${tid}/translation`), { env: e }))).translation).toBe("Hello.");
  });

  it("formula repair returns one repair per formula, or a clear error for unusable output", async () => {
    const good = await gatewayEnv({ chat: () => ({ text: '```json\n["x^{2}", "\\\\frac{a}{b}"]\n```' }) });
    const { tid } = await pdfText();
    const res = await json(await call(api(`/texts/${tid}/formula-repair`), { method: "POST", body: { formulas: ["x^{2", "\\frac{a}{b"] }, env: good }));
    expect(res.formulas).toEqual([{ original: "x^{2", repaired: "x^{2}" }, { original: "\\frac{a}{b", repaired: "\\frac{a}{b}" }]);
    const bad = await gatewayEnv({ chat: () => ({ text: "Sure! Here you go." }) });
    expect((await json(await call(api(`/texts/${tid}/formula-repair`), { method: "POST", body: { formulas: ["x^{2"] }, env: bad }))).error.code).toBe("bad_model_output");
    expect((await call(api(`/texts/${tid}/formula-repair`), { method: "POST", body: { formulas: Array(51).fill("x") }, env: bad })).status).toBe(400);
  });
});

describe("saved per-text settings reach the model call", () => {
  it("OCR uses the text's saved prompt, temperature, token budget and model; a model chosen for the run wins", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "Transcribed page" }) });
    const { tid, pageId } = await imagePage(ALICE, e);
    expect((await call(api(`/texts/${tid}/settings`), { method: "POST", body: { prompt: "Transcribe this letter exactly.", temperature: 0.4, max_tokens: 1500, model: "vision-plain" }, env: e })).status).toBe(200);
    expect((await ocr(tid, pageId, e)).status).toBe(200);
    const [first] = await chatBodies(e);
    expect(first).toMatchObject({ model: "vision-plain", temperature: 0.4, max_tokens: 1500 });
    expect(first.messages[0].content[0]).toEqual({ type: "text", text: "Transcribe this letter exactly." });
    // a model named for one run overrides the saved one (reasoning headroom applies to it)
    expect((await ocr(tid, pageId, e, { model: "vision-thinker", overwrite: true })).status).toBe(200);
    const second = (await chatBodies(e))[1];
    expect(second.model).toBe("vision-thinker");
    expect(second.max_tokens).toBe(1500 + REASONING_HEADROOM);
    // reset: the defaults again
    await call(api(`/texts/${tid}/settings`), { method: "DELETE", env: e });
    expect((await ocr(tid, pageId, e, { overwrite: true })).status).toBe(200);
    const third = (await chatBodies(e))[2];
    expect(third).toMatchObject({ temperature: 0.1, max_tokens: 4096 });
    expect(third.messages[0].content[0].text).not.toBe("Transcribe this letter exactly.");
  });
});
