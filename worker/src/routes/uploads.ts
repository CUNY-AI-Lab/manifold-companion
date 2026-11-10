// Uploads and authorized reads of stored bytes. Streamed raw bodies (no
// multipart parsing in the Worker); the browser has already resized/rotated
// images. Nothing here processes images or PDFs.
import { Hono } from "hono";
import { requireTextRole } from "../authz";
import { reindexText, touchProject } from "../content";
import { limits } from "../env";
import { E } from "../errors";
import { serveBody } from "../files";
import { figureKey, pageImageKey, sourcePdfRevisionKey } from "../r2-keys";
import { commitReservation, deleteRowAndRelease, releaseStatement } from "../storage";
import { cleanFilename, declaredSize, imageKind, receive, sniffImage, sniffPdf } from "../uploads";
import { isUuid, newId, nowIso } from "../util";
import type { AppEnv } from "../app";

export const uploadRoutes = new Hono<AppEnv>();
const idOf = (c: { req: { param: (n: string) => string | undefined } }): string => c.req.param("id") as string;
const isUnique = (e: unknown): boolean => e instanceof Error && /UNIQUE/i.test(e.message);

// ---- page images -----------------------------------------------------------

/** The text (or its project) was deleted while the upload was in flight: answer as for a missing text. */
async function textStillThere(db: D1Database, textId: string): Promise<void> {
  if (!(await db.prepare("SELECT 1 AS x FROM texts WHERE id = ?1").bind(textId).first())) throw E.notFound("Text not found.");
}

uploadRoutes.post("/:id/pages", async (c) => {
  const subject = c.get("principal").subject;
  const { text, project } = await requireTextRole(c.env.DB, subject, idOf(c), "editor");
  if (project.project_type !== "image_to_markdown") throw E.badRequest("Page images belong to image_to_markdown projects.", "wrong_project_type");
  const lim = limits(c.env);
  const filename = cleanFilename(c.req.query("filename"));
  const size = declaredSize(c.req.query("size"), lim.maxFileBytes);

  // Cheap refusals first, so no quota is reserved for an upload that cannot succeed.
  const taken = await c.env.DB.prepare("SELECT 1 AS x FROM pages WHERE text_id = ?1 AND filename = ?2").bind(text.id, filename).first();
  if (taken) throw E.conflict("A page with that file name already exists in this text. Rename the file or delete the old page.", "filename_exists");
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pages p JOIN texts t ON t.id = p.text_id WHERE t.project_id = ?1").bind(project.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= lim.maxProjectPages) throw E.conflict(`A project can hold at most ${lim.maxProjectPages} pages.`, "page_limit_reached");

  const got = await receive(c.env, c.req.raw, project.id, size, sniffImage);
  const pageId = newId();
  const key = pageImageKey(project.id, text.id, pageId);
  try {
    await c.env.FILES.put(key, got.bytes, { httpMetadata: { contentType: got.type } });
    // The cap is re-checked inside the insert, so racing uploads cannot pass it together.
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO pages (id, text_id, filename, page_number, image_key, image_bytes, image_type)
         SELECT ?1, ?2, ?3, (SELECT COALESCE(MAX(page_number), 0) + 1 FROM pages WHERE text_id = ?2), ?4, ?5, ?6
         WHERE EXISTS (SELECT 1 FROM texts WHERE id = ?2) AND (SELECT COUNT(*) FROM pages p JOIN texts t ON t.id = p.text_id WHERE t.project_id = ?7) < ?8`,
      ).bind(pageId, text.id, filename, key, size, got.type, project.id, lim.maxProjectPages),
      ...commitReservation(c.env.DB, got.reservation, "EXISTS (SELECT 1 FROM pages WHERE id = ?2)", pageId),
    ]);
    if (res?.meta.changes !== 1) {
      await textStillThere(c.env.DB, text.id);
      throw E.conflict(`A project can hold at most ${lim.maxProjectPages} pages.`, "page_limit_reached");
    }
  } catch (error) {
    await c.env.FILES.delete(key).catch(() => undefined);
    await got.release();
    if (isUnique(error)) throw E.conflict("A page with that file name already exists in this text.", "filename_exists");
    throw error;
  }
  await touchProject(c.env.DB, project.id);
  const page = await c.env.DB.prepare("SELECT id, text_id, filename, page_number, image_bytes, image_type FROM pages WHERE id = ?1").bind(pageId).first();
  return c.json({ page }, 201);
});

uploadRoutes.get("/:id/pages/:pageId/image", async (c) => {
  const { text } = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const pageId = c.req.param("pageId") as string;
  const page = isUuid(pageId) ? await c.env.DB.prepare("SELECT filename, image_key, image_type FROM pages WHERE id = ?1 AND text_id = ?2").bind(pageId, text.id).first<{ filename: string; image_key: string | null; image_type: string | null }>() : null;
  if (!page || !page.image_key) throw E.notFound("Image not found.");
  const obj = await c.env.FILES.get(page.image_key);
  if (!obj) throw E.notFound("Image not found.");
  return serveBody(obj.body, imageKind(page.image_type ?? "image/jpeg"), page.filename);
});

// ---- source PDF ------------------------------------------------------------

uploadRoutes.put("/:id/source-pdf", async (c) => {
  const subject = c.get("principal").subject;
  const { text, project } = await requireTextRole(c.env.DB, subject, idOf(c), "editor");
  if (project.project_type !== "pdf_to_html") throw E.badRequest("Source PDFs belong to pdf_to_html projects.", "wrong_project_type");
  const lim = limits(c.env);
  const filename = cleanFilename(c.req.query("filename"));
  const size = declaredSize(c.req.query("size"), lim.maxPdfBytes);
  const replace = c.req.query("replace") === "1";
  if (text.source_pdf_key && !replace) throw E.conflict("This text already has a source PDF. Send ?replace=1 to replace it.", "pdf_exists");

  const got = await receive(c.env, c.req.raw, project.id, size, (b) => (sniffPdf(b) ? ("application/pdf" as const) : null));
  const key = sourcePdfRevisionKey(project.id, text.id, newId());
  try {
    await c.env.FILES.put(key, got.bytes, { httpMetadata: { contentType: "application/pdf" } });
    // One transaction: the new PDF's reservation is committed and the old PDF's bytes released only if this swap landed.
    const swapped = "EXISTS (SELECT 1 FROM texts WHERE id = ?3 AND source_pdf_key = ?4)";
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE texts SET source_pdf_key = ?1, source_pdf_bytes = ?2, source_pdf_name = ?3, updated_at = ?4 WHERE id = ?5 AND source_pdf_key IS ?6`,
      ).bind(key, size, filename, nowIso(), text.id, text.source_pdf_key),
      ...commitReservation(c.env.DB, got.reservation, "EXISTS (SELECT 1 FROM texts WHERE id = ?2 AND source_pdf_key = ?3)", text.id, key),
      ...(text.source_pdf_key ? releaseStatement(c.env.DB, project.id, text.source_pdf_bytes, swapped, text.id, key) : []),
    ]);
    if (res?.meta.changes !== 1) throw E.conflict("The source PDF was changed by someone else. Reload and try again.", "edit_conflict");
  } catch (error) {
    await c.env.FILES.delete(key).catch(() => undefined);
    await got.release();
    throw error;
  }
  if (text.source_pdf_key) await c.env.FILES.delete(text.source_pdf_key).catch(() => undefined);
  await touchProject(c.env.DB, project.id);
  return c.json({ ok: true, source_pdf_name: filename, bytes: size }, 201);
});

uploadRoutes.get("/:id/source-pdf", async (c) => {
  const { text } = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  if (!text.source_pdf_key) throw E.notFound("No source PDF.");
  const obj = await c.env.FILES.get(text.source_pdf_key);
  if (!obj) throw E.notFound("No source PDF.");
  return serveBody(obj.body, "pdf", text.source_pdf_name ?? "source.pdf");
});

// ---- figure crops (PDF-to-HTML) --------------------------------------------

uploadRoutes.post("/:id/figures", async (c) => {
  const { text, project } = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  if (project.project_type !== "pdf_to_html") throw E.badRequest("Figures belong to pdf_to_html projects.", "wrong_project_type");
  const lim = limits(c.env);
  const filename = cleanFilename(c.req.query("filename"));
  const size = declaredSize(c.req.query("size"), lim.maxFileBytes);
  const have = await c.env.DB.prepare("SELECT COUNT(*) AS n, SUM(filename = ?2) AS same FROM figures WHERE text_id = ?1").bind(text.id, filename).first<{ n: number; same: number | null }>();
  if (have?.same) throw E.conflict("A figure with that file name already exists.", "filename_exists");
  if ((have?.n ?? 0) >= lim.maxFiguresPerText) throw E.conflict(`A text can hold at most ${lim.maxFiguresPerText} figures.`, "figure_limit_reached");
  const dim = (name: string): number | null => {
    const v = c.req.query(name);
    if (v === undefined) return null;
    if (!/^\d{1,5}$/.test(v) || Number(v) < 1) throw E.badRequest(`${name} must be a positive integer.`);
    return Number(v);
  };
  const width = dim("width");
  const height = dim("height");
  const got = await receive(c.env, c.req.raw, project.id, size, sniffImage);
  const id = newId();
  const key = figureKey(project.id, text.id, id);
  try {
    await c.env.FILES.put(key, got.bytes, { httpMetadata: { contentType: got.type } });
    // Conditional insert: the per-text cap is checked inside the statement, so racing uploads cannot pass it together.
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO figures (id, text_id, filename, image_key, image_type, bytes, created_at, width, height) SELECT ?1,?2,?3,?4,?5,?6,?7,?9,?10 WHERE EXISTS (SELECT 1 FROM texts WHERE id = ?2) AND (SELECT COUNT(*) FROM figures WHERE text_id = ?2) < ?8",
      ).bind(id, text.id, filename, key, got.type, size, nowIso(), lim.maxFiguresPerText, width, height),
      ...commitReservation(c.env.DB, got.reservation, "EXISTS (SELECT 1 FROM figures WHERE id = ?2)", id),
    ]);
    if (res?.meta.changes !== 1) {
      await textStillThere(c.env.DB, text.id);
      throw E.conflict(`A text can hold at most ${lim.maxFiguresPerText} figures.`, "figure_limit_reached");
    }
  } catch (error) {
    await c.env.FILES.delete(key).catch(() => undefined);
    await got.release();
    if (isUnique(error)) throw E.conflict("A figure with that file name already exists.", "filename_exists");
    throw error;
  }
  await touchProject(c.env.DB, project.id);
  return c.json({ figure: { id, filename, image_type: got.type, bytes: size } }, 201);
});

uploadRoutes.get("/:id/figures", async (c) => {
  const { text } = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const rows = await c.env.DB.prepare("SELECT id, filename, image_type, bytes, width, height, created_at FROM figures WHERE text_id = ?1 ORDER BY created_at, rowid").bind(text.id).all();
  return c.json({ figures: rows.results });
});

uploadRoutes.get("/:id/figures/:figureId", async (c) => {
  const { text } = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const fid = c.req.param("figureId") as string;
  const fig = isUuid(fid) ? await c.env.DB.prepare("SELECT filename, image_key, image_type FROM figures WHERE id = ?1 AND text_id = ?2").bind(fid, text.id).first<{ filename: string; image_key: string; image_type: string }>() : null;
  if (!fig) throw E.notFound("Figure not found.");
  const obj = await c.env.FILES.get(fig.image_key);
  if (!obj) throw E.notFound("Figure not found.");
  return serveBody(obj.body, imageKind(fig.image_type), fig.filename);
});

uploadRoutes.delete("/:id/figures/:figureId", async (c) => {
  const { text, project } = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "editor");
  const fid = c.req.param("figureId") as string;
  const fig = isUuid(fid) ? await c.env.DB.prepare("SELECT id, image_key FROM figures WHERE id = ?1 AND text_id = ?2").bind(fid, text.id).first<{ id: string; image_key: string }>() : null;
  if (!fig) throw E.notFound("Figure not found.");
  // Only the request whose DELETE removes the row releases the bytes (one atomic batch).
  if (!(await deleteRowAndRelease(c.env.DB, project.id, "figures", fig.id, "bytes", text.id))) throw E.notFound("Figure not found.");
  await c.env.FILES.delete(fig.image_key).catch(() => undefined);
  await touchProject(c.env.DB, project.id);
  await reindexText(c.env, text.id);
  return c.json({ ok: true });
});
