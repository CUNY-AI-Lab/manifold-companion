// Model tasks. Each is a user-initiated POST for ONE unit of work (one page,
// one chunk, one text), makes exactly one Gateway attempt, and spends the
// signed-in person's own allowance via the forwarded Gateway leg.
import { Hono } from "hono";
import { requireTextRole } from "../authz";
import { readJsonObject } from "../body";
import { byteLength, CAPS, getContent, reindexText, touchProject, writeContent, writePageText, type TextRow } from "../content";
import { limits } from "../env";
import { AppError, E } from "../errors";
import { freshCorrelation, gatewayClient, runChat } from "../gateway";
import { loadCatalog, policyFrom, resolveModel, resolveRunModel, thinksOnMath, type ModelOption } from "../models";
import { cleanupDocumentHtml, toDataUri } from "../model-output";
import { formulaRepairTask, MAX_TRANSLATE_CHUNK_CHARS, ocrTask, pageHtmlTask, parseFormulaRepair, parseOcr, parsePageHtml, parseSummary, parseTranslation, summaryTask, translateTask } from "../task-specs";
import { htmlToPlainText, sanitizeHtml } from "../sanitize/html";
import { isUuid, nowIso } from "../util";
import type { AppEnv } from "../app";
import { logger, terminalFor } from "../logging";
import type { MiddlewareHandler } from "hono";

/** One model_task.completed event per model task request, with the route TEMPLATE only. */
const logged = (template: string): MiddlewareHandler<AppEnv> => async (c, next) => {
  const started = Date.now();
  await next();
  const status = c.res.status;
  const err = c.error;
  const code = err instanceof AppError ? err.code : err ? "internal_error" : status >= 400 ? (status === 409 ? "edit_conflict" : "error") : null;
  const terminal = terminalFor(status, code);
  const base = { request_id: c.get("requestId"), route: `/manifold-companion/api/texts${template}`, duration_ms: Date.now() - started, status };
  if (terminal.outcome === "ok") logger(c.env).emit("model_task.completed", { ...base, terminal });
  else logger(c.env).emit("model_task.completed", { ...base, terminal, ...(code ? { error_type: code } : {}) });
};

export const taskRoutes = new Hono<AppEnv>();
const idOf = (c: { req: { param: (n: string) => string | undefined } }): string => c.req.param("id") as string;

/** A page image sent to a model is capped (Media Tools uses the same 4 MiB); the browser resizes before upload. */
export const MAX_MODEL_IMAGE_BYTES = 4 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const LANGUAGES = new Set(("en es fr de it pt ru zh ja ko ar hi nl sv da no fi pl cs el tr he th vi uk ro hu id ms ca hr sk bg sr lt lv et sl ga sq mk bs mt is cy la auto-detect").split(" "));

interface Settings { prompt: string | null; model: string | null; math_model: string | null; temperature: number | null; max_tokens: number | null }

async function settingsOf(db: D1Database, textId: string): Promise<Settings> {
  return (await db.prepare("SELECT prompt, model, math_model, temperature, max_tokens FROM text_settings WHERE text_id = ?1").bind(textId).first<Settings>()) ?? { prompt: null, model: null, math_model: null, temperature: null, max_tokens: null };
}

function modelChoice(body: Record<string, unknown>): string | undefined {
  const m = body.model;
  if (m === undefined || m === null || m === "") return undefined;
  if (typeof m !== "string" || !MODEL_ID.test(m)) throw E.badRequest("Invalid model.");
  return m;
}

async function catalogFor(c: { env: AppEnv["Bindings"]; req: { raw: Request } }): Promise<ModelOption[]> {
  return loadCatalog(gatewayClient(c.env, freshCorrelation(c.req.raw)), Date.now(), c.req.raw.signal);
}

const usageOf = (u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null) => u ?? undefined;

// ---- OCR one page ----------------------------------------------------------

taskRoutes.post("/:id/pages/:pageId/ocr", logged("/{id}/pages/{pageId}/ocr"), async (c) => {
  const principal = c.get("principal");
  const ctx = await requireTextRole(c.env.DB, principal.subject, idOf(c), "editor");
  if (ctx.project.project_type !== "image_to_markdown") throw E.badRequest("OCR belongs to image_to_markdown projects.", "wrong_project_type");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const pageId = c.req.param("pageId") as string;
  const page = isUuid(pageId) ? await c.env.DB.prepare("SELECT * FROM pages WHERE id = ?1 AND text_id = ?2").bind(pageId, ctx.text.id).first<{ id: string; filename: string; ocr_text: string | null; image_key: string | null; image_type: string | null; image_bytes: number }>() : null;
  if (!page) throw E.notFound("Page not found.");
  if (!page.image_key) throw E.conflict("This page has no image to read.", "no_image");
  // Never replace existing text implicitly. Even with overwrite=true the old text is saved
  // as a version first (writePageText), and the write is compare-and-set against what we read,
  // so a person's edit made while the model was thinking is never clobbered.
  if (page.ocr_text && page.ocr_text.trim() !== "" && body.overwrite !== true) {
    throw E.conflict("This page already has text. Send overwrite: true to replace it; the current text is saved as a version first.", "page_has_text");
  }
  if (page.image_bytes > MAX_MODEL_IMAGE_BYTES) throw E.tooLarge("This page image is too large to send to a model. Re-upload a smaller (resized) image.", "image_too_large_for_model");

  const settings = await settingsOf(c.env.DB, ctx.text.id);
  const catalog = await catalogFor(c);
  const model = resolveRunModel("ocr", catalog, c.env, modelChoice(body), settings.model);
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.slice(0, 3000) : undefined;
  const obj = await c.env.FILES.get(page.image_key);
  if (!obj) throw E.conflict("The page image is missing.", "object_missing");
  const dataUri = toDataUri(new Uint8Array(await obj.arrayBuffer()), page.image_type ?? "image/jpeg");

  const result = await runChat(c.env, principal, c.req.raw, ocrTask(model, dataUri, settings, prompt));
  const text = parseOcr(result.text);
  try {
    // Compare-and-set against the text read BEFORE the model call; the old text is saved as a version first.
    await writePageText(c.env, ctx.project, ctx.text.id, page, text, principal.subject, model.id);
  } catch (error) {
    // Someone edited the page while the model was reading it. Their edit wins and is kept;
    // the (already paid for) model text is handed back so the person can compare and choose.
    if (error instanceof AppError && error.code === "edit_conflict") {
      return c.json(
        { error: { code: "edit_conflict", message: "This page was edited while the model was reading it. Your edit was kept; the model's text is included so you can compare.", requestId: c.get("requestId"), retryable: false }, result: { text, model: model.id } },
        409,
        { "x-should-retry": "false", "cache-control": "no-store" },
      );
    }
    throw error;
  }
  // All pages have text now: the text is OCR'd.
  await c.env.DB.prepare(
    "UPDATE texts SET status = 'ocrd', updated_at = ?2 WHERE id = ?1 AND status IN ('pending', 'processing') AND NOT EXISTS (SELECT 1 FROM pages WHERE text_id = ?1 AND (ocr_text IS NULL OR ocr_text = ''))",
  ).bind(ctx.text.id, nowIso()).run();
  return c.json({ page_id: page.id, text, model: model.id, usage: usageOf(result.usage), gateway_request_id: result.gatewayRequestId });
});

// ---- one page image -> structured HTML (not stored; the client assembles and PUTs) ----

const IMAGE_DATA_URI = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

taskRoutes.post("/:id/parse-page", logged("/{id}/parse-page"), async (c) => {
  const principal = c.get("principal");
  const ctx = await requireTextRole(c.env.DB, principal.subject, idOf(c), "editor");
  if (ctx.project.project_type !== "pdf_to_html") throw E.badRequest("Page conversion belongs to pdf_to_html projects.", "wrong_project_type");
  const body = await readJsonObject(c.req.raw, CAPS.documentBodyBytes);
  const match = typeof body.image === "string" ? IMAGE_DATA_URI.exec(body.image) : null;
  if (!match) throw E.badRequest("image must be a base64 JPEG, PNG or WebP data URI.", "image_invalid");
  const approxBytes = Math.floor(((match[2] as string).length * 3) / 4);
  if (approxBytes > MAX_MODEL_IMAGE_BYTES) throw E.tooLarge("The page image is too large. Render it at a smaller scale.", "image_too_large_for_model");
  const pageNumber = body.page_number;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 100_000) throw E.badRequest("page_number must be a positive integer.");
  const totalPages = typeof body.total_pages === "number" && Number.isInteger(body.total_pages) && body.total_pages >= pageNumber ? body.total_pages : null;
  const hint = typeof body.text_hint === "string" ? body.text_hint : "";
  const math = body.math === true;

  // Figure files the model may reference: only ones that exist for this text.
  let figures: { filename: string; width: number | null; height: number | null }[] = [];
  if (body.figures !== undefined) {
    if (!Array.isArray(body.figures) || body.figures.length > 20 || body.figures.some((f) => typeof f !== "string")) throw E.badRequest("figures must be a list of up to 20 file names.");
    const names = [...new Set(body.figures as string[])];
    if (names.length > 0) {
      const rows = await c.env.DB.prepare(`SELECT filename, width, height FROM figures WHERE text_id = ?1 AND filename IN (${names.map((_, i) => `?${i + 2}`).join(",")})`).bind(ctx.text.id, ...names).all<{ filename: string; width: number | null; height: number | null }>();
      if (rows.results.length !== names.length) throw E.badRequest("Every listed figure must be uploaded to this text first.", "figure_unknown");
      figures = rows.results;
    }
  }

  const settings = await settingsOf(c.env.DB, ctx.text.id);
  const catalog = await catalogFor(c);
  const model = math ? resolveRunModel("html_math", catalog, c.env, modelChoice(body), settings.math_model) : resolveRunModel("html_page", catalog, c.env, modelChoice(body), settings.model);
  const result = await runChat(c.env, principal, c.req.raw, pageHtmlTask(model, { imageDataUri: body.image as string, pageNumber, totalPages, hint, math, thinking: math && thinksOnMath(model, policyFrom(c.env)), figures }, settings));
  const { html, shortOutput, warnings } = parsePageHtml(result.text, pageNumber, hint);
  return c.json({
    html, model: model.id, math,
    // One attempt only: a suspiciously short result is reported so the person can retry, not retried here.
    short_output: shortOutput,
    // Things to check by eye (figure values read off a graph, list numbering restarted); reported, not retried.
    warnings,
    usage: usageOf(result.usage), gateway_request_id: result.gatewayRequestId,
  });
});

// Deterministic structure cleanup (the legacy "cleanup" never called a model).
taskRoutes.post("/:id/html/cleanup", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  if (ctx.project.project_type !== "pdf_to_html") throw E.badRequest("Cleanup belongs to pdf_to_html projects.", "wrong_project_type");
  const body = await readJsonObject(c.req.raw, CAPS.documentBodyBytes);
  if (typeof body.html !== "string" || !body.html.trim()) throw E.badRequest("HTML is required.");
  if (body.html.length > CAPS.htmlInputChars) throw E.tooLarge("HTML is too long.");
  return c.json({ html: sanitizeHtml(cleanupDocumentHtml(body.html)) });
});

// ---- summary ---------------------------------------------------------------

async function sourceText(env: AppEnv["Bindings"], ctx: { text: TextRow; project: { project_type: string } }): Promise<string> {
  if (ctx.project.project_type === "pdf_to_html") {
    const html = await getContent(env, ctx.text.html_key);
    return html ? htmlToPlainText(html) : "";
  }
  const compiled = await getContent(env, ctx.text.compiled_key);
  if (compiled) return compiled;
  const pages = await env.DB.prepare("SELECT ocr_text FROM pages WHERE text_id = ?1 AND ocr_text IS NOT NULL AND ocr_text != '' ORDER BY page_number, rowid").bind(ctx.text.id).all<{ ocr_text: string }>();
  return pages.results.map((p) => p.ocr_text).join("\n\n---\n\n");
}

taskRoutes.get("/:id/summary", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  return c.json({ summary: ctx.text.summary });
});

taskRoutes.put("/:id/summary", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  if (typeof body.summary !== "string") throw E.badRequest("summary must be a string.");
  if (byteLength(body.summary) > CAPS.summaryBytes) throw E.tooLarge(`summary is larger than ${CAPS.summaryBytes} bytes.`);
  await c.env.DB.prepare("UPDATE texts SET summary = ?1, updated_at = ?2 WHERE id = ?3").bind(body.summary, nowIso(), ctx.text.id).run();
  await touchProject(c.env.DB, ctx.project.id);
  await reindexText(c.env, ctx.text.id);
  return c.json({ summary: body.summary });
});

taskRoutes.post("/:id/summary", logged("/{id}/summary"), async (c) => {
  const principal = c.get("principal");
  const ctx = await requireTextRole(c.env.DB, principal.subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const source = await sourceText(c.env, ctx);
  if (source.trim() === "") throw E.badRequest("There is no text to summarise yet.", "no_text");
  const language = typeof body.language === "string" && LANGUAGES.has(body.language) ? body.language : ctx.text.source_language ?? ctx.project.default_language;
  const model = resolveModel("text", await catalogFor(c), c.env, modelChoice(body));
  const { task, truncatedInput: truncated } = summaryTask(model, source, language);
  const result = await runChat(c.env, principal, c.req.raw, task);
  const summary = parseSummary(result.text);
  await c.env.DB.prepare("UPDATE texts SET summary = ?1, updated_at = ?2 WHERE id = ?3").bind(summary, nowIso(), ctx.text.id).run();
  await touchProject(c.env.DB, ctx.project.id);
  await reindexText(c.env, ctx.text.id);
  return c.json({ summary, model: model.id, truncated_input: truncated, usage: usageOf(result.usage), gateway_request_id: result.gatewayRequestId });
});

// ---- translation (the client drives chunking) -------------------------------

taskRoutes.post("/:id/translate-chunk", logged("/{id}/translate-chunk"), async (c) => {
  const principal = c.get("principal");
  await requireTextRole(c.env.DB, principal.subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  if (typeof body.text !== "string" || body.text.trim() === "") throw E.badRequest("text is required.");
  if (body.text.length > MAX_TRANSLATE_CHUNK_CHARS) throw E.tooLarge(`A chunk can be at most ${MAX_TRANSLATE_CHUNK_CHARS} characters; split it and send the pieces one at a time.`, "chunk_too_large");
  const { source_language: src, target_language: tgt } = body;
  if (typeof src !== "string" || !LANGUAGES.has(src) || typeof tgt !== "string" || !LANGUAGES.has(tgt) || tgt === "auto-detect") throw E.badRequest("Invalid source or target language.");
  const model = resolveModel("text", await catalogFor(c), c.env, modelChoice(body));
  const result = await runChat(c.env, principal, c.req.raw, translateTask(model, body.text, src, tgt));
  return c.json({ text: parseTranslation(result.text), model: model.id, usage: usageOf(result.usage), gateway_request_id: result.gatewayRequestId });
});

taskRoutes.get("/:id/translation", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  return c.json({ translation: await getContent(c.env, ctx.text.translation_key), source_language: ctx.text.source_language, target_language: ctx.text.target_language });
});

taskRoutes.put("/:id/translation", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, CAPS.documentBodyBytes);
  if (typeof body.translation !== "string") throw E.badRequest("translation must be a string.");
  if (byteLength(body.translation) > CAPS.translationBytes) throw E.tooLarge(`The translation is larger than ${CAPS.translationBytes} bytes.`);
  await writeContent(c.env, ctx.project, ctx.text, "translation", body.translation, c.get("principal").subject);
  return c.json({ ok: true });
});

// ---- formula repair --------------------------------------------------------
// The legacy endpoint was a stub that returned []. This asks a text model to fix TeX that failed to render.

taskRoutes.post("/:id/formula-repair", logged("/{id}/formula-repair"), async (c) => {
  const principal = c.get("principal");
  const ctx = await requireTextRole(c.env.DB, principal.subject, idOf(c), "editor");
  if (ctx.project.project_type !== "pdf_to_html") throw E.badRequest("Formula repair belongs to pdf_to_html projects.", "wrong_project_type");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const f = body.formulas;
  if (!Array.isArray(f) || f.length === 0) throw E.badRequest("A non-empty formulas array is required.");
  if (f.length > 50) throw E.badRequest("Too many formulas in one request (max 50).");
  if (f.some((x) => typeof x !== "string" || x.length === 0 || x.length > 2000)) throw E.badRequest("Each formula must be a non-empty string of at most 2000 characters.");
  const model = resolveModel("text", await catalogFor(c), c.env, modelChoice(body));
  const result = await runChat(c.env, principal, c.req.raw, formulaRepairTask(model, f as string[]));
  const formulas = parseFormulaRepair(result.text, f as string[]);
  return c.json({ formulas, model: model.id, usage: usageOf(result.usage), gateway_request_id: result.gatewayRequestId });
});
