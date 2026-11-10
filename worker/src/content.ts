// Large-content storage (R2 + D1 pointers), versions, quota deltas, search
// text maintenance. D1 rows must stay far below the 2,000,000-byte row limit,
// which Miniflare does NOT enforce, so every cap here is enforced in code.
import { E } from "./errors";
import { limits, type Env } from "./env";
import { contentKey, pageVersionKey, type ContentKind } from "./r2-keys";
import { commitReservation, ownerSql, releaseReservation, releaseStatement, reserveStorage } from "./storage";
import { htmlToPlainText, sanitizeHtml, MAX_SANITIZE_INPUT_CHARS } from "./sanitize/html";
import { newId, nowIso } from "./util";
import { ensureSearchIndex } from "./search";
import type { ProjectRow } from "./authz";

export const CAPS = {
  /** Input HTML characters accepted (the sanitizer's own limit; larger input is refused, never truncated). */
  htmlInputChars: MAX_SANITIZE_INPUT_CHARS,
  /** Stored bytes of sanitized HTML (escaping can expand input). */
  htmlStoredBytes: 5 * 1024 * 1024,
  compiledBytes: 2 * 1024 * 1024,
  translationBytes: 2 * 1024 * 1024,
  /** One page of OCR text kept in D1. 300 pages x 128 KiB stays under D1's 50 MB result cap. */
  pageOcrBytes: 128 * 1024,
  summaryBytes: 20 * 1024,
  pdfMetaBytes: 8 * 1024,
  searchTextChars: 400_000,
  searchPageChars: 12_000,
  /** JSON body ceiling for routes that carry a document (HTML 2M chars + escaping + envelope). */
  documentBodyBytes: 6 * 1024 * 1024,
  maxTextsPerProject: 500,
  maxVersions: 50,
  /** Page versions are kept per page, so re-reading a long text cannot push out other pages' history. */
  maxPageVersions: 20,
} as const;

export const byteLength = (s: string): number => new TextEncoder().encode(s).byteLength;

export interface TextRow {
  id: string;
  project_id: string;
  name: string;
  status: "pending" | "processing" | "ocrd" | "reviewed";
  sort_order: number;
  summary: string | null;
  source_language: string | null;
  target_language: string | null;
  source_pdf_name: string | null;
  pdf_meta: string | null;
  formula_repair_status: string | null;
  html_key: string | null;
  html_bytes: number;
  compiled_key: string | null;
  compiled_bytes: number;
  translation_key: string | null;
  translation_bytes: number;
  source_pdf_key: string | null;
  source_pdf_bytes: number;
  search_text: string | null;
  created_at: string;
  updated_at: string;
}

export async function getContent(env: Env, key: string | null): Promise<string | null> {
  if (!key) return null;
  const obj = await env.FILES.get(key);
  return obj ? await obj.text() : null;
}

export async function touchProject(db: D1Database, projectId: string, now = nowIso()): Promise<void> {
  await db.prepare("UPDATE projects SET last_edited_at = ?1, updated_at = ?1, retention_warned_at = NULL WHERE id = ?2").bind(now, projectId).run();
}

// The owner of the project pays for storage (editor uploads count against the
// owner). Counter changes name the owner in SQL (storage.ts ownerSql), never
// from the project row read at authorization: a transfer can land in between.

// ---- search text ----------------------------------------------------------

/** Rebuild the extracted plain text and the FTS row for one text. FTS failure degrades to the LIKE fallback column. */
export async function reindexText(env: Env, textId: string, hint: { html?: string } = {}): Promise<void> {
  const t = await env.DB.prepare("SELECT id, project_id, name, summary, html_key, compiled_key FROM texts WHERE id = ?1").bind(textId).first<Pick<TextRow, "id" | "project_id" | "name" | "summary" | "html_key" | "compiled_key">>();
  if (!t) return;
  const parts: string[] = [];
  if (t.summary) parts.push(t.summary);
  const html = hint.html ?? (await getContent(env, t.html_key));
  if (html) parts.push(htmlToPlainText(html));
  const compiled = await getContent(env, t.compiled_key);
  if (compiled) parts.push(compiled);
  const pages = await env.DB.prepare("SELECT substr(ocr_text, 1, ?2) AS s FROM pages WHERE text_id = ?1 AND ocr_text IS NOT NULL ORDER BY page_number, rowid").bind(textId, CAPS.searchPageChars).all<{ s: string }>();
  let budget = CAPS.searchTextChars;
  for (const p of pages.results) {
    if (budget <= 0) break;
    parts.push(p.s.slice(0, budget));
    budget -= p.s.length;
  }
  const meta = await env.DB.prepare("SELECT dc_title, dc_creator, dc_subject, dc_description FROM metadata WHERE text_id = ?1").bind(textId).first<Record<string, string | null>>();
  if (meta) parts.push(Object.values(meta).filter(Boolean).join(" "));
  const body = parts.join("\n").slice(0, CAPS.searchTextChars);
  await env.DB.prepare("UPDATE texts SET search_text = ?1 WHERE id = ?2").bind(body, textId).run();
  if (!(await ensureSearchIndex(env.DB))) return;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM text_fts WHERE text_id = ?1").bind(textId),
      env.DB.prepare("INSERT INTO text_fts (text_id, project_id, title, body) VALUES (?1, ?2, ?3, ?4)").bind(textId, t.project_id, t.name, body),
    ]);
  } catch {
    // FTS5 unavailable or the index is damaged: search_text above still serves the LIKE fallback.
  }
}

// ---- versions -------------------------------------------------------------

/** Why a version was saved: the action that replaced that content. */
export type VersionReason = "save" | "ocr" | "conversion" | "restore";

/** Keep the newest versions per text+type (per page for page versions); delete the rest, their objects, and release their bytes. */
export async function pruneVersions(env: Env, project: ProjectRow, textId: string, contentType: "compiled" | "html" | "page", pageFilename: string | null = null): Promise<void> {
  const old = contentType === "page"
    ? await env.DB.prepare(
      "SELECT id, r2_key, bytes FROM text_versions WHERE text_id = ?1 AND content_type = 'page' AND page_filename IS ?2 ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?3",
    ).bind(textId, pageFilename, CAPS.maxPageVersions).all<{ id: string; r2_key: string; bytes: number }>()
    : await env.DB.prepare(
      "SELECT id, r2_key, bytes FROM text_versions WHERE text_id = ?1 AND content_type = ?2 ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?3",
    ).bind(textId, contentType, CAPS.maxVersions).all<{ id: string; r2_key: string; bytes: number }>();
  if (old.results.length === 0) return;
  for (let i = 0; i < old.results.length; i += 80) {
    const chunk = old.results.slice(i, i + 80);
    const marks = chunk.map((_, n) => `?${n + 2}`).join(",");
    const ids = chunk.map((c) => c.id);
    // One transaction: the release is computed from the rows that still exist, so a
    // concurrent prune that already removed them releases nothing the second time,
    // and goes to the project's owner as of this transaction.
    await env.DB.batch([
      env.DB.prepare(`UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - COALESCE((SELECT SUM(bytes) FROM text_versions WHERE id IN (${marks}) AND text_id = ?${chunk.length + 2}), 0)) WHERE subject = ${ownerSql("?1")}`).bind(project.id, ...ids, textId),
      env.DB.prepare(`DELETE FROM text_versions WHERE id IN (${marks}) AND text_id = ?${chunk.length + 2}`).bind(project.id, ...ids, textId),
    ]);
    await env.FILES.delete(chunk.map((c) => c.r2_key)).catch(() => undefined); // an orphan is swept with the project
  }
}

const KIND_COLS = {
  html: { key: "html_key", bytes: "html_bytes", versioned: true },
  compiled: { key: "compiled_key", bytes: "compiled_bytes", versioned: true },
  translation: { key: "translation_key", bytes: "translation_bytes", versioned: false },
} as const;

/**
 * A version's author as the transaction sees it: NULL once their profile is
 * gone ("delete my data" while their write was in flight), as the profile's
 * ON DELETE SET NULL would have made it, instead of a foreign-key failure.
 */
const AUTHOR = (placeholder: string): string => `(SELECT subject FROM profiles WHERE subject = ${placeholder})`;

export interface WriteOptions {
  /** Extra column assignments applied in the same atomic update (names are fixed by callers, never user input). */
  extraSets?: { sql: string; value: unknown }[];
  /** Why the previous content is being replaced (stored on its version). */
  reason?: VersionReason;
}

/**
 * Replace html / compiled / translation content with optimistic concurrency.
 *
 * The new content goes to a fresh R2 key; the previous object is kept as the
 * version snapshot for html and compiled (so "snapshot current before
 * overwrite" is by construction, no copy needed). The pointer swap, the version
 * row and the version-ness are one D1 batch guarded by a compare-and-set on the
 * old pointer: a concurrent writer gets `409 edit_conflict` and nothing is lost.
 */
export async function writeContent(env: Env, project: ProjectRow, text: TextRow, kind: ContentKind, content: string, authorSubject: string, opts: WriteOptions = {}): Promise<{ bytes: number }> {
  const cols = KIND_COLS[kind];
  const bytes = byteLength(content);
  const oldKey = text[cols.key] as string | null;
  const oldBytes = text[cols.bytes] as number;
  const versioned = cols.versioned && oldKey !== null && oldBytes > 0;
  const net = bytes - (versioned ? 0 : oldKey ? oldBytes : 0);
  const reservation = net > 0 ? await reserveStorage(env, project.id, net) : null;

  const revision = newId();
  const newKey = contentKey(project.id, text.id, kind, revision);
  const now = nowIso();
  try {
    await env.FILES.put(newKey, content, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    const extra = opts.extraSets ?? [];
    const sets = [`${cols.key} = ?1`, `${cols.bytes} = ?2`, "updated_at = ?3", ...extra.map((e, i) => `${e.sql} = ?${i + 5}`)];
    const statements: D1PreparedStatement[] = [];
    if (versioned) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO text_versions (id, text_id, content_type, r2_key, bytes, created_by, created_at, reason)
           SELECT ?1, ?2, ?3, ?4, ?5, ${AUTHOR("?6")}, ?7, ?8 WHERE EXISTS (SELECT 1 FROM texts WHERE id = ?2 AND ${cols.key} IS ?4)`,
        ).bind(newId(), text.id, kind, oldKey, oldBytes, authorSubject, now, opts.reason ?? "save"),
      );
    }
    statements.push(
      env.DB.prepare(`UPDATE texts SET ${sets.join(", ")} WHERE id = ?4 AND ${cols.key} IS ${oldKey === null ? "NULL" : "?" + (extra.length + 5)}`).bind(
        newKey, bytes, now, text.id, ...extra.map((e) => e.value), ...(oldKey === null ? [] : [oldKey]),
      ),
    );
    const swapAt = statements.length - 1;
    // Same transaction, only if THIS swap landed (the new key is unique to this request):
    // commit the reservation, or give back the bytes the smaller content no longer needs.
    const swapped = `EXISTS (SELECT 1 FROM texts WHERE id = ?3 AND ${cols.key} = ?4)`;
    statements.push(...commitReservation(env.DB, reservation, `EXISTS (SELECT 1 FROM texts WHERE id = ?2 AND ${cols.key} = ?3)`, text.id, newKey));
    if (net < 0) statements.push(...releaseStatement(env.DB, project.id, -net, swapped, text.id, newKey));
    const results = await env.DB.batch(statements);
    if (results[swapAt]?.meta.changes !== 1) throw E.conflict("This text was changed by someone else. Reload and try again.", "edit_conflict");
  } catch (error) {
    await env.FILES.delete(newKey).catch(() => undefined);
    await releaseReservation(env.DB, reservation);
    throw error;
  }
  if (!versioned && oldKey) await env.FILES.delete(oldKey).catch(() => undefined);
  if (versioned) await pruneVersions(env, project, text.id, kind as "html" | "compiled");
  await touchProject(env.DB, project.id, now);
  return { bytes };
}

/**
 * Stop using an image text's edited full text: the export goes back to the
 * page texts. The current full text is kept as a `compiled` version (restoring
 * it brings it back), so its bytes move from the text row to the version row
 * inside one transaction and no counter changes (DESIGN 6). A compare-and-set
 * on the pointer: a concurrent save gets `409 edit_conflict` and nothing moves.
 * An empty full text has no version (as writeContent keeps none) and its
 * object is deleted after the swap. Returns false when there is none.
 */
export async function clearCompiled(env: Env, project: ProjectRow, text: TextRow, authorSubject: string): Promise<boolean> {
  const oldKey = text.compiled_key;
  if (!oldKey) return false;
  const versioned = text.compiled_bytes > 0;
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (versioned) {
    statements.push(env.DB.prepare(
      `INSERT INTO text_versions (id, text_id, content_type, r2_key, bytes, created_by, created_at, reason)
       SELECT ?1, ?2, 'compiled', ?3, ?4, ${AUTHOR("?5")}, ?6, 'save' WHERE EXISTS (SELECT 1 FROM texts WHERE id = ?2 AND compiled_key = ?3 AND compiled_bytes = ?4)`,
    ).bind(newId(), text.id, oldKey, text.compiled_bytes, authorSubject, now));
  }
  statements.push(env.DB.prepare("UPDATE texts SET compiled_key = NULL, compiled_bytes = 0, updated_at = ?1 WHERE id = ?2 AND compiled_key = ?3 AND compiled_bytes = ?4").bind(now, text.id, oldKey, text.compiled_bytes));
  const results = await env.DB.batch(statements);
  if (results[results.length - 1]?.meta.changes !== 1) throw E.conflict("This text was changed by someone else. Reload and try again.", "edit_conflict");
  if (versioned) await pruneVersions(env, project, text.id, "compiled");
  else await env.FILES.delete(oldKey).catch(() => undefined);
  await touchProject(env.DB, project.id, now);
  return true;
}

/** Sanitize-then-store an HTML document. Refuses (never truncates) over-long input. */
export function prepareHtml(raw: unknown): string {
  if (typeof raw !== "string") throw E.badRequest("html_content must be a string.");
  if (raw.length > CAPS.htmlInputChars) throw E.tooLarge(`HTML is longer than ${CAPS.htmlInputChars} characters.`);
  const clean = sanitizeHtml(raw);
  if (byteLength(clean) > CAPS.htmlStoredBytes) throw E.tooLarge("The sanitized HTML is too large.");
  return clean;
}

/**
 * Save a page's OCR/edited text. The previous text, if any and different, is
 * snapshotted as a `page` version first (R2 object, charged to the owner), and
 * the swap is a compare-and-set on the old text. Used by hand edits, reverts
 * AND model OCR, so a model can never silently overwrite corrected text.
 */
export async function writePageText(env: Env, project: ProjectRow, textId: string, page: { id: string; filename: string; ocr_text: string | null }, newText: string, authorSubject: string, ocrModel?: string, reason: VersionReason = ocrModel ? "ocr" : "save"): Promise<void> {
  if (byteLength(newText) > CAPS.pageOcrBytes) throw E.tooLarge(`Page text is larger than ${CAPS.pageOcrBytes} bytes.`, "page_text_too_large");
  const old = page.ocr_text;
  const snapshot = old !== null && old !== "" && old !== newText;
  const snapBytes = snapshot ? byteLength(old as string) : 0;
  const reservation = snapBytes > 0 ? await reserveStorage(env, project.id, snapBytes) : null;
  const now = nowIso();
  const vKey = snapshot ? pageVersionKey(project.id, textId, newId()) : null;
  const versionId = newId();
  try {
    if (vKey) await env.FILES.put(vKey, old as string, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    const statements: D1PreparedStatement[] = [];
    if (vKey) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO text_versions (id, text_id, content_type, page_filename, r2_key, bytes, created_by, created_at, reason)
           SELECT ?1, ?2, 'page', ?3, ?4, ?5, ${AUTHOR("?6")}, ?7, ?10 WHERE EXISTS (SELECT 1 FROM pages WHERE id = ?8 AND text_id = ?2 AND ocr_text IS ?9)`,
        ).bind(versionId, textId, page.filename, vKey, snapBytes, authorSubject, now, page.id, old, reason),
      );
    }
    // A model write records which model produced the text; a human edit leaves the field as it was.
    // Only while the page is still in this text: a page whose text moved to another project is not written by a request authorized here.
    statements.push(env.DB.prepare("UPDATE pages SET ocr_text = ?1, processed_at = ?2, ocr_model = COALESCE(?5, ocr_model) WHERE id = ?3 AND text_id = ?6 AND ocr_text IS ?4").bind(newText, now, page.id, old, ocrModel ?? null, textId));
    const swapAt = statements.length - 1;
    // The snapshot's reservation is committed only if THIS batch wrote the version row.
    statements.push(...commitReservation(env.DB, reservation, "EXISTS (SELECT 1 FROM text_versions WHERE id = ?2)", versionId));
    const results = await env.DB.batch(statements);
    if (results[swapAt]?.meta.changes !== 1) throw E.conflict("This page was changed by someone else. Reload and try again.", "edit_conflict");
  } catch (error) {
    if (vKey) await env.FILES.delete(vKey).catch(() => undefined);
    await releaseReservation(env.DB, reservation);
    throw error;
  }
  if (snapshot) await pruneVersions(env, project, textId, "page", page.filename);
  await env.DB.prepare("UPDATE texts SET updated_at = ?1 WHERE id = ?2").bind(now, textId).run();
  await touchProject(env.DB, project.id, now);
  await reindexText(env, textId);
}

export { limits };
