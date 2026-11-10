// Whole-text operations: delete, split, merge. Object copies are sequential
// (each costs 2 subrequests against the 1000/invocation budget), so the page
// count of one operation is capped well below it.
import type { ProjectRow } from "./authz";
import { reindexText, touchProject, ownerOf } from "./content";
import { limits, type Env } from "./env";
import { E } from "./errors";
import { pageImageKey, textPrefix } from "./r2-keys";
import { deleteR2Prefix, releaseStorage, reserveStorage, textBytesSql } from "./storage";
import { newId, nowIso } from "./util";

export const MAX_PAGES_PER_COPY_OP = 300;

export async function textStorageBytes(db: D1Database, textId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT html_bytes + translation_bytes + source_pdf_bytes + compiled_bytes FROM texts WHERE id = ?1), 0)
            + COALESCE((SELECT SUM(image_bytes) FROM pages WHERE text_id = ?1), 0)
            + COALESCE((SELECT SUM(bytes) FROM text_versions WHERE text_id = ?1), 0)
            + COALESCE((SELECT SUM(bytes) FROM figures WHERE text_id = ?1), 0) AS bytes`,
    )
    .bind(textId)
    .first<{ bytes: number }>();
  return row?.bytes ?? 0;
}

/** Delete one text of `project` with its objects, releasing the owner's bytes once. False if this call did not remove it. */
export async function deleteTextObjects(env: Env, project: ProjectRow, textId: string): Promise<boolean> {
  const exists = await env.DB.prepare("SELECT 1 AS x FROM texts WHERE id = ?1 AND project_id = ?2").bind(textId, project.id).first();
  if (!exists) return false;
  await deleteR2Prefix(env.FILES, textPrefix(project.id, textId));
  const [, del] = await env.DB.batch([
    env.DB.prepare(`UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - ${textBytesSql("?1")}) WHERE subject = ?2 AND EXISTS (SELECT 1 FROM texts WHERE id = ?1 AND project_id = ?3)`).bind(textId, ownerOf(project), project.id),
    env.DB.prepare("DELETE FROM texts WHERE id = ?1 AND project_id = ?2").bind(textId, project.id), // cascades; FTS row by trigger
  ]);
  return (del?.meta.changes ?? 0) > 0;
}

interface PageSrc {
  id: string;
  filename: string;
  page_number: number | null;
  ocr_text: string | null;
  image_key: string | null;
  image_bytes: number;
}

async function checkPageCap(env: Env, project: ProjectRow, adding: number): Promise<void> {
  if (adding > MAX_PAGES_PER_COPY_OP) throw E.badRequest(`At most ${MAX_PAGES_PER_COPY_OP} pages can be copied at once.`);
  const cap = limits(env).maxProjectPages;
  const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages p JOIN texts t ON t.id = p.text_id WHERE t.project_id = ?1").bind(project.id).first<{ n: number }>();
  if ((have?.n ?? 0) + adding > cap) throw E.conflict(`A project can hold at most ${cap} pages.`, "page_limit_reached");
}

/**
 * Create `targets` (new texts) holding copies of the given pages. Quota for all
 * image bytes is reserved atomically up front; any failure removes the new
 * objects/rows and releases the reservation.
 */
async function copyIntoNewTexts(env: Env, project: ProjectRow, targets: { name: string; status: string; pages: { src: PageSrc; filename: string }[] }[]): Promise<{ id: string; name: string }[]> {
  const all = targets.flatMap((t) => t.pages);
  await checkPageCap(env, project, all.length);
  const textCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM texts WHERE project_id = ?1").bind(project.id).first<{ n: number }>();
  if ((textCount?.n ?? 0) + targets.length > limits(env).maxTextsPerProject) throw E.conflict(`A project can hold at most ${limits(env).maxTextsPerProject} texts.`, "text_limit_reached");
  const need = all.reduce((n, p) => n + p.src.image_bytes, 0);
  const owner = ownerOf(project);
  if (need > 0) await reserveStorage(env, owner, need);
  const created: { id: string; name: string }[] = [];
  const writtenKeys: string[] = [];
  const base = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM texts WHERE project_id = ?1").bind(project.id).first<{ m: number }>();
  const now = nowIso();
  try {
    const cap = limits(env);
    let order = base?.m ?? 0;
    const statements: D1PreparedStatement[] = [];
    const textStatementAt: number[] = [];
    let textsLeft = targets.length;
    let pagesLeft = all.length;
    for (const target of targets) {
      const textId = newId();
      created.push({ id: textId, name: target.name });
      // ONE batch (one transaction) for the whole operation, and every insert checks
      // "existing + still to add <= cap" against the state it sees. Concurrent operations
      // are serialized by D1, so exactly the ones that fit succeed and a refused one leaves no
      // partial rows behind to starve the others.
      textStatementAt.push(statements.length);
      statements.push(
        env.DB.prepare(
          "INSERT INTO texts (id, project_id, name, status, sort_order, created_at, updated_at) SELECT ?1,?2,?3,?4,?5,?6,?6 WHERE (SELECT COUNT(*) FROM texts WHERE project_id = ?2) + ?7 <= ?8",
        ).bind(textId, project.id, target.name, target.status, ++order, now, textsLeft--, cap.maxTextsPerProject),
      );
      let n = 1;
      for (const { src, filename } of target.pages) {
        const pageId = newId();
        let key: string | null = null;
        if (src.image_key) {
          const obj = await env.FILES.get(src.image_key);
          if (!obj) throw E.conflict("A page image is missing and cannot be copied.", "object_missing");
          key = pageImageKey(project.id, textId, pageId);
          await env.FILES.put(key, await obj.arrayBuffer(), { httpMetadata: obj.httpMetadata });
          writtenKeys.push(key);
        }
        statements.push(
          env.DB.prepare(
            `INSERT INTO pages (id, text_id, filename, page_number, ocr_text, processed_at, image_key, image_bytes)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8
             WHERE EXISTS (SELECT 1 FROM texts WHERE id = ?2) AND (SELECT COUNT(*) FROM pages p JOIN texts t ON t.id = p.text_id WHERE t.project_id = ?9) + ?10 <= ?11`,
          ).bind(pageId, textId, filename, n++, src.ocr_text, src.ocr_text ? now : null, key, key ? src.image_bytes : 0, project.id, pagesLeft--, cap.maxProjectPages),
        );
      }
    }
    const results = await env.DB.batch(statements);
    if (textStatementAt.some((i) => results[i]?.meta.changes !== 1)) throw E.conflict(`A project can hold at most ${cap.maxTextsPerProject} texts.`, "text_limit_reached");
    if (results.some((r) => r.meta.changes !== 1)) throw E.conflict(`A project can hold at most ${cap.maxProjectPages} pages.`, "page_limit_reached");
  } catch (error) {
    for (const t of created) await env.DB.prepare("DELETE FROM texts WHERE id = ?1").bind(t.id).run().catch(() => undefined);
    if (writtenKeys.length) await env.FILES.delete(writtenKeys).catch(() => undefined);
    if (need > 0) await releaseStorage(env.DB, owner, need);
    throw error;
  }
  for (const t of created) await reindexText(env, t.id);
  await touchProject(env.DB, project.id, now);
  return created;
}

export async function splitText(env: Env, project: ProjectRow, textId: string, status: string, splits: { name: string; pages: number[] }[]): Promise<{ id: string; name: string }[]> {
  const pages = await env.DB.prepare("SELECT id, filename, page_number, ocr_text, image_key, image_bytes FROM pages WHERE text_id = ?1").bind(textId).all<PageSrc>();
  const byNumber = new Map(pages.results.map((p) => [p.page_number, p]));
  const targets = splits.map((s) => ({
    name: s.name,
    status,
    pages: s.pages.flatMap((n) => {
      const src = byNumber.get(n);
      return src ? [{ src, filename: src.filename }] : [];
    }),
  }));
  return copyIntoNewTexts(env, project, targets);
}

export async function mergeTexts(env: Env, project: ProjectRow, textIds: string[], name: string): Promise<{ id: string; name: string }> {
  const pages: { src: PageSrc; filename: string }[] = [];
  for (const [i, id] of textIds.entries()) {
    const rows = await env.DB.prepare("SELECT id, filename, page_number, ocr_text, image_key, image_bytes FROM pages WHERE text_id = ?1 ORDER BY page_number, rowid").bind(id).all<PageSrc>();
    for (const src of rows.results) pages.push({ src, filename: `t${i + 1}_${src.filename}` });
  }
  const [created] = await copyIntoNewTexts(env, project, [{ name, status: "ocrd", pages }]);
  return created as { id: string; name: string };
}
