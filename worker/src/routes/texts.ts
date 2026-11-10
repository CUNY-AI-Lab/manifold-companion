// Per-text routes, mounted at /texts/:id. Every handler authorizes through
// requireTextRole exactly once with the least role it needs.
import { Hono } from "hono";
import { requireTextRole, type Access } from "../authz";
import { readJsonObject, optionalString } from "../body";
import { byteLength, CAPS, getContent, prepareHtml, reindexText, touchProject, writeContent, writePageText, ownerOf, type TextRow } from "../content";
import { limits } from "../env";
import { E } from "../errors";
import { deleteTextObjects, splitText } from "../text-ops";
import { releaseStorage } from "../storage";
import { isUuid, nowIso } from "../util";
import type { AppEnv } from "../app";

export const textRoutes = new Hono<AppEnv>();

const LANGUAGES = new Set(
  ("en es fr de it pt ru zh ja ko ar hi nl sv da no fi pl cs el tr he th vi uk ro hu id ms ca hr sk bg sr lt lv et sl ga sq mk bs mt is cy la auto-detect").split(" "),
);
const STATUSES = new Set(["pending", "processing", "ocrd", "reviewed"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const DC_FIELDS = ["dc_title", "dc_creator", "dc_subject", "dc_description", "dc_date", "dc_type", "dc_format", "dc_language", "dc_source", "dc_rights", "dc_coverage", "dc_contributor", "dc_publisher", "dc_relation", "dc_identifier"] as const;

type Ctx = Access & { text: TextRow };
const idOf = (c: { req: { param: (n: string) => string | undefined } }): string => c.req.param("id") as string;

function publicText(t: TextRow) {
  return {
    id: t.id, project_id: t.project_id, name: t.name, status: t.status, sort_order: t.sort_order, summary: t.summary,
    source_language: t.source_language, target_language: t.target_language, source_pdf_name: t.source_pdf_name,
    pdf_meta: t.pdf_meta, formula_repair_status: t.formula_repair_status, has_html: t.html_key !== null,
    has_compiled: t.compiled_key !== null, has_translation: t.translation_key !== null, has_source_pdf: t.source_pdf_key !== null,
    created_at: t.created_at, updated_at: t.updated_at,
  };
}

function requireType(ctx: Ctx, type: "image_to_markdown" | "pdf_to_html"): void {
  if (ctx.project.project_type !== type) throw E.badRequest(`This action is only available for ${type} projects.`, "wrong_project_type");
}

interface PageRow { id: string; text_id: string; filename: string; page_number: number | null; ocr_text: string | null; ocr_model: string | null; processed_at: string | null; image_key: string | null; image_bytes: number }

async function loadPages(db: D1Database, textId: string) {
  const rows = await db.prepare("SELECT id, text_id, filename, page_number, ocr_text, ocr_model, processed_at, image_key, image_bytes FROM pages WHERE text_id = ?1 ORDER BY page_number, rowid").bind(textId).all<PageRow>();
  return rows.results.map(({ image_key, ...p }) => ({ ...p, has_image: image_key !== null }));
}

async function loadPage(db: D1Database, textId: string, pageId: string): Promise<PageRow> {
  if (!isUuid(pageId)) throw E.notFound("Page not found.");
  const page = await db.prepare("SELECT * FROM pages WHERE id = ?1 AND text_id = ?2").bind(pageId, textId).first<PageRow>();
  if (!page) throw E.notFound("Page not found.");
  return page;
}

// ---- text ------------------------------------------------------------------

textRoutes.get("/:id", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  return c.json({ text: publicText(ctx.text), pages: await loadPages(c.env.DB, ctx.text.id), project_type: ctx.project.project_type, role: ctx.role });
});

textRoutes.put("/:id", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const sets: string[] = [];
  const values: unknown[] = [];
  const name = optionalString(body, "name", 200);
  if (name !== undefined) {
    if (name === "") throw E.badRequest("name cannot be empty.");
    sets.push("name = ?"); values.push(name);
  }
  if (body.summary !== undefined) {
    if (body.summary !== null && typeof body.summary !== "string") throw E.badRequest("summary must be a string or null.");
    if (typeof body.summary === "string" && byteLength(body.summary) > CAPS.summaryBytes) throw E.tooLarge(`summary is larger than ${CAPS.summaryBytes} bytes.`);
    sets.push("summary = ?"); values.push(body.summary);
  }
  for (const key of ["source_language", "target_language"] as const) {
    if (body[key] !== undefined) {
      const v = body[key];
      if (v !== null && v !== "" && (typeof v !== "string" || !LANGUAGES.has(v))) throw E.badRequest(`Invalid ${key.replace("_", " ")} code.`);
      sets.push(`${key} = ?`); values.push(v === "" ? null : v);
    }
  }
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUSES.has(body.status)) throw E.badRequest("Invalid status.");
    sets.push("status = ?"); values.push(body.status);
  }
  if (sets.length === 0) throw E.badRequest("Nothing to update.");
  const now = nowIso();
  await c.env.DB.prepare(`UPDATE texts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...values, now, ctx.text.id).run();
  await touchProject(c.env.DB, ctx.project.id, now);
  if (name !== undefined || body.summary !== undefined) await reindexText(c.env, ctx.text.id);
  const fresh = await c.env.DB.prepare("SELECT * FROM texts WHERE id = ?1").bind(ctx.text.id).first<TextRow>();
  return c.json({ text: publicText(fresh as TextRow) });
});

textRoutes.delete("/:id", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  await deleteTextObjects(c.env, ctx.project, ctx.text.id);
  await touchProject(c.env.DB, ctx.project.id);
  return c.json({ ok: true });
});

// ---- pages -----------------------------------------------------------------

textRoutes.get("/:id/pages", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  requireType(ctx, "image_to_markdown");
  return c.json({ pages: await loadPages(c.env.DB, ctx.text.id) });
});

textRoutes.put("/:id/pages/reorder", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  requireType(ctx, "image_to_markdown");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const ids = body.pageIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) throw E.badRequest("pageIds must be a non-empty array of at most 1000 ids.");
  const own = await c.env.DB.prepare("SELECT id FROM pages WHERE text_id = ?1").bind(ctx.text.id).all<{ id: string }>();
  const have = new Set(own.results.map((r) => r.id));
  if (new Set(ids).size !== ids.length || ids.some((i) => typeof i !== "string" || !have.has(i)) || ids.length !== have.size) {
    throw E.badRequest("pageIds must list every page of this text exactly once.");
  }
  await c.env.DB.batch((ids as string[]).map((id, i) => c.env.DB.prepare("UPDATE pages SET page_number = ?1 WHERE id = ?2 AND text_id = ?3").bind(i + 1, id, ctx.text.id)));
  await touchProject(c.env.DB, ctx.project.id);
  return c.json({ ok: true });
});

textRoutes.post("/:id/pages/:pageId", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  requireType(ctx, "image_to_markdown");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  if (typeof body.text !== "string") throw E.badRequest("Text content is required.");
  const page = await loadPage(c.env.DB, ctx.text.id, c.req.param("pageId") as string);
  await writePageText(c.env, ctx.project, ctx.text.id, page, body.text, c.get("principal").subject);
  return c.json({ ok: true });
});

textRoutes.delete("/:id/pages/:pageId", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const page = await loadPage(c.env.DB, ctx.text.id, c.req.param("pageId") as string);
  if (page.image_key) await c.env.FILES.delete(page.image_key);
  await c.env.DB.prepare("DELETE FROM pages WHERE id = ?1").bind(page.id).run();
  await releaseStorage(c.env.DB, ownerOf(ctx.project), page.image_bytes);
  await touchProject(c.env.DB, ctx.project.id);
  await reindexText(c.env, ctx.text.id);
  return c.json({ ok: true });
});

// ---- compiled / html -------------------------------------------------------

textRoutes.get("/:id/result", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const pages = await loadPages(c.env.DB, ctx.text.id);
  const compiled = pages.filter((p) => p.ocr_text).map((p) => p.ocr_text).join("\n\n---\n\n");
  return c.json({ text: compiled, pageCount: pages.length });
});

textRoutes.get("/:id/compiled", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  return c.json({ text: await getContent(c.env, ctx.text.compiled_key), updated_at: ctx.text.updated_at });
});

textRoutes.post("/:id/save", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  if (typeof body.text !== "string") throw E.badRequest("Text content is required.");
  if (byteLength(body.text) > CAPS.compiledBytes) throw E.tooLarge(`Text is larger than ${CAPS.compiledBytes} bytes.`);
  await writeContent(c.env, ctx.project, ctx.text, "compiled", body.text, c.get("principal").subject);
  await reindexText(c.env, ctx.text.id);
  return c.json({ ok: true });
});

textRoutes.get("/:id/html", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  requireType(ctx, "pdf_to_html");
  return c.json({
    html_content: (await getContent(c.env, ctx.text.html_key)) ?? "",
    source_pdf_name: ctx.text.source_pdf_name,
    pdf_meta: ctx.text.pdf_meta,
    formula_repair_status: ctx.text.formula_repair_status,
    updated_at: ctx.text.updated_at,
  });
});

textRoutes.put("/:id/html", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  requireType(ctx, "pdf_to_html");
  const body = await readJsonObject(c.req.raw, CAPS.documentBodyBytes);
  if (body.html_content === undefined) throw E.badRequest("HTML content is required.");
  const clean = prepareHtml(body.html_content);
  const extra: { sql: string; value: unknown }[] = [];
  if (body.pdf_meta !== undefined) {
    const meta = JSON.stringify(body.pdf_meta);
    if (byteLength(meta) > CAPS.pdfMetaBytes) throw E.tooLarge("pdf_meta is too large.");
    extra.push({ sql: "pdf_meta", value: meta });
  }
  if (body.formula_repair_status !== undefined) {
    if (typeof body.formula_repair_status !== "string" || body.formula_repair_status.length > 40) throw E.badRequest("Invalid formula_repair_status.");
    extra.push({ sql: "formula_repair_status", value: body.formula_repair_status });
  }
  const { bytes } = await writeContent(c.env, ctx.project, ctx.text, "html", clean, c.get("principal").subject, { extraSets: extra });
  await reindexText(c.env, ctx.text.id, { html: clean });
  return c.json({ ok: true, html_bytes: bytes, sanitized: clean !== body.html_content });
});

// ---- metadata & settings ---------------------------------------------------

textRoutes.get("/:id/metadata", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const row = await c.env.DB.prepare("SELECT * FROM metadata WHERE text_id = ?1").bind(ctx.text.id).first();
  return c.json({ metadata: row ?? {} });
});

textRoutes.post("/:id/metadata", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const values: (string | null)[] = [];
  for (const f of DC_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null || v === "") { values.push(null); continue; }
    if (typeof v !== "string" || v.length > 2000) throw E.badRequest(`${f} must be a string of at most 2000 characters.`);
    values.push(v);
  }
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO metadata (text_id, ${DC_FIELDS.join(", ")}, updated_at) VALUES (?1, ${DC_FIELDS.map((_, i) => `?${i + 2}`).join(", ")}, ?${DC_FIELDS.length + 2})
     ON CONFLICT(text_id) DO UPDATE SET ${DC_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")}, updated_at = excluded.updated_at`,
  ).bind(ctx.text.id, ...values, now).run();
  await touchProject(c.env.DB, ctx.project.id, now);
  await reindexText(c.env, ctx.text.id);
  return c.json({ metadata: await c.env.DB.prepare("SELECT * FROM metadata WHERE text_id = ?1").bind(ctx.text.id).first() });
});

textRoutes.get("/:id/settings", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const row = await c.env.DB.prepare("SELECT prompt, model, math_model, temperature, max_tokens, updated_at FROM text_settings WHERE text_id = ?1").bind(ctx.text.id).first();
  return c.json({ settings: row ?? {} });
});

textRoutes.post("/:id/settings", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const cur = (await c.env.DB.prepare("SELECT prompt, model, math_model, temperature, max_tokens FROM text_settings WHERE text_id = ?1").bind(ctx.text.id).first<Record<string, unknown>>()) ?? {};
  const next: Record<string, unknown> = { prompt: null, model: null, math_model: null, temperature: null, max_tokens: null, ...cur };
  if (body.prompt !== undefined) {
    if (body.prompt !== null && (typeof body.prompt !== "string" || body.prompt.length > 3000)) throw E.badRequest("Prompt must be 3000 characters or fewer.");
    next.prompt = body.prompt;
  }
  for (const key of ["model", "math_model"] as const) {
    if (body[key] !== undefined) {
      if (body[key] !== null && body[key] !== "" && (typeof body[key] !== "string" || !MODEL_ID.test(body[key] as string))) throw E.badRequest(`Invalid ${key}.`);
      next[key] = body[key] || null;
    }
  }
  if (body.temperature !== undefined) {
    const t = Number(body.temperature);
    if (body.temperature === null) next.temperature = null;
    else if (!Number.isFinite(t) || t < 0 || t > 1) throw E.badRequest("Temperature must be between 0 and 1.");
    else next.temperature = t;
  }
  if (body.max_tokens !== undefined) {
    const m = Number(body.max_tokens);
    if (body.max_tokens === null) next.max_tokens = null;
    else if (!Number.isInteger(m) || m < 1 || m > 8192) throw E.badRequest("max_tokens must be an integer from 1 to 8192.");
    else next.max_tokens = m;
  }
  await c.env.DB.prepare(
    `INSERT INTO text_settings (text_id, prompt, model, math_model, temperature, max_tokens, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(text_id) DO UPDATE SET prompt = excluded.prompt, model = excluded.model, math_model = excluded.math_model, temperature = excluded.temperature, max_tokens = excluded.max_tokens, updated_at = excluded.updated_at`,
  ).bind(ctx.text.id, next.prompt, next.model, next.math_model, next.temperature, next.max_tokens, nowIso()).run();
  const row = await c.env.DB.prepare("SELECT prompt, model, math_model, temperature, max_tokens, updated_at FROM text_settings WHERE text_id = ?1").bind(ctx.text.id).first();
  return c.json({ settings: row });
});

textRoutes.delete("/:id/settings", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  await c.env.DB.prepare("DELETE FROM text_settings WHERE text_id = ?1").bind(ctx.text.id).run();
  return c.json({ ok: true });
});

// ---- versions --------------------------------------------------------------

textRoutes.get("/:id/versions", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const type = c.req.query("type");
  if (type !== "compiled" && type !== "html" && type !== "page") throw E.badRequest("Type must be compiled, html, or page.");
  const rows = await c.env.DB.prepare(
    `SELECT v.id, v.content_type, v.page_filename, v.bytes, v.created_by, p.display_name AS author_name, v.created_at
     FROM text_versions v LEFT JOIN profiles p ON p.subject = v.created_by
     WHERE v.text_id = ?1 AND v.content_type = ?2 ORDER BY v.created_at DESC, v.rowid DESC LIMIT ?3`,
  ).bind(ctx.text.id, type, CAPS.maxVersions).all();
  return c.json({ versions: rows.results });
});

interface VersionRow { id: string; text_id: string; content_type: "compiled" | "html" | "page"; page_filename: string | null; r2_key: string; bytes: number; created_by: string | null; created_at: string }

async function loadVersion(db: D1Database, textId: string, versionId: string): Promise<VersionRow> {
  if (!isUuid(versionId)) throw E.notFound("Version not found.");
  const v = await db.prepare("SELECT * FROM text_versions WHERE id = ?1 AND text_id = ?2").bind(versionId, textId).first<VersionRow>();
  if (!v) throw E.notFound("Version not found.");
  return v;
}

textRoutes.get("/:id/versions/:versionId", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const v = await loadVersion(c.env.DB, ctx.text.id, c.req.param("versionId") as string);
  const content = await getContent(c.env, v.r2_key);
  if (content === null) throw E.gone("This version's content is no longer available.", "version_unavailable");
  const { r2_key: _k, ...rest } = v;
  return c.json({ version: { ...rest, content } });
});

// Revert = write the old content as the new current content. writeContent /
// writePageText snapshot the CURRENT content first (the legacy page branch
// snapshotted the version being restored instead and lost the current text).
textRoutes.post("/:id/versions/:versionId/revert", async (c) => {
  const subject = c.get("principal").subject;
  const ctx = await requireTextRole(c.env.DB, subject, idOf(c), "editor");
  const v = await loadVersion(c.env.DB, ctx.text.id, c.req.param("versionId") as string);
  const content = await getContent(c.env, v.r2_key);
  if (content === null) throw E.gone("This version's content is no longer available.", "version_unavailable");
  if (v.content_type === "page") {
    const page = v.page_filename ? await c.env.DB.prepare("SELECT * FROM pages WHERE text_id = ?1 AND filename = ?2").bind(ctx.text.id, v.page_filename).first<PageRow>() : null;
    if (!page) throw E.conflict("The page this version belongs to no longer exists.", "page_missing");
    await writePageText(c.env, ctx.project, ctx.text.id, page, content, subject);
  } else if (v.content_type === "html") {
    await writeContent(c.env, ctx.project, ctx.text, "html", prepareHtml(content), subject);
    await reindexText(c.env, ctx.text.id);
  } else {
    await writeContent(c.env, ctx.project, ctx.text, "compiled", content, subject);
    await reindexText(c.env, ctx.text.id);
  }
  return c.json({ ok: true });
});

// ---- split -----------------------------------------------------------------

textRoutes.post("/:id/split", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const splits = body.splits;
  if (!Array.isArray(splits) || splits.length < 2) throw E.badRequest("At least 2 splits are required.");
  if (splits.length > 20) throw E.badRequest("Cannot create more than 20 splits at once.");
  const parsed = splits.map((s) => {
    const o = s as { name?: unknown; pages?: unknown };
    if (typeof o?.name !== "string" || !o.name.trim() || o.name.length > 200 || !Array.isArray(o.pages) || o.pages.length === 0 || o.pages.length > 1000 || !o.pages.every((n) => Number.isInteger(n))) {
      throw E.badRequest("Each split needs a name and at least one page number.");
    }
    return { name: o.name.trim(), pages: o.pages as number[] };
  });
  const texts = await splitText(c.env, ctx.project, ctx.text.id, ctx.text.status, parsed);
  return c.json({ texts }, 201);
});


