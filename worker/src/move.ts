// Moving texts to another project (DESIGN 6, "Move a text"). A moved text gets
// a NEW id in the destination; its pages, figures, versions, metadata and
// settings rows are re-parented to it, and every object is copied under the
// destination's prefix first (R2 keys embed the project and text ids). One D1
// batch per text then swaps everything, moves the bytes from the source owner
// to the destination owner (both named in SQL as the transaction sees them),
// deletes the old text row (its comments go with it, by decision: they were
// written for the source project's members) and tombstones the old prefix.
//
// Why a new id: every request that writes to a text was authorized against
// the old id and project, and every one of those writes is conditioned on the
// old text still existing (or a row still belonging to it). Once the move
// commits they all fail cleanly, so nothing authorized on the source project
// lands in the destination, and no counter is charged for a row in a project
// its owner does not own. It also means no object prefix is ever reused, so a
// tombstone left by an earlier move can never sweep a later one's objects.
//
// All or nothing per text: a guard at the end of the batch breaks the counter
// CHECK (storage_bytes >= 0), rolling the batch back, if anything changed
// under the move (a row whose object was not copied), or the destination is
// over its text or page cap, or (owners differ) its owner is over quota.
import type { ProjectRow } from "./authz";
import { reindexText, type TextRow } from "./content";
import { limits, type Env } from "./env";
import { AppError, E } from "./errors";
import { textPrefix } from "./r2-keys";
import { ownerSql, sweepTombstone, textBytesSql } from "./storage";
import { newId, nowIso } from "./util";

export const MOVE_LIMITS = {
  textsPerRequest: 50,
  /** Objects copied in one request (each copy is two R2 calls). */
  objectsPerRequest: 1500,
  /** Bytes copied in one request. */
  bytesPerRequest: 256 * 1024 * 1024,
} as const;

export interface TextPlan {
  text: TextRow;
  pages: number;
  figures: number;
  versions: number;
  comments: number;
  bytes: number;
  /** Every object a row of this text names: [key, bytes]. */
  objects: [string, number][];
}

export async function planText(db: D1Database, src: ProjectRow, textId: string): Promise<TextPlan | null> {
  const text = await db.prepare("SELECT * FROM texts WHERE id = ?1 AND project_id = ?2").bind(textId, src.id).first<TextRow>();
  if (!text) return null;
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM pages WHERE text_id = ?1) AS pages, (SELECT COUNT(*) FROM figures WHERE text_id = ?1) AS figures,
              (SELECT COUNT(*) FROM text_versions WHERE text_id = ?1) AS versions, (SELECT COUNT(*) FROM annotations WHERE text_id = ?1) AS comments,
              ${textBytesSql("?1")} AS bytes`,
    )
    .bind(textId)
    .first<{ pages: number; figures: number; versions: number; comments: number; bytes: number }>();
  const objects: [string, number][] = [];
  for (const [k, b] of [[text.html_key, text.html_bytes], [text.compiled_key, text.compiled_bytes], [text.translation_key, text.translation_bytes], [text.source_pdf_key, text.source_pdf_bytes]] as const) if (k) objects.push([k, b]);
  // Separate statements: D1 limits the terms of a compound SELECT.
  for (const sql of [
    "SELECT image_key AS k, image_bytes AS b FROM pages WHERE text_id = ?1 AND image_key IS NOT NULL",
    "SELECT image_key AS k, bytes AS b FROM figures WHERE text_id = ?1",
    "SELECT r2_key AS k, bytes AS b FROM text_versions WHERE text_id = ?1",
  ]) {
    const rows = await db.prepare(sql).bind(textId).all<{ k: string; b: number }>();
    for (const r of rows.results) objects.push([r.k, r.b]);
  }
  return { text, pages: counts?.pages ?? 0, figures: counts?.figures ?? 0, versions: counts?.versions ?? 0, comments: counts?.comments ?? 0, bytes: counts?.bytes ?? 0, objects };
}

/** Where an object of the old text goes: the same path under the new text's prefix. */
export function movedKey(oldKey: string, src: string, oldText: string, dst: string, newText: string): string {
  const from = textPrefix(src, oldText);
  return oldKey.startsWith(from) ? `${textPrefix(dst, newText)}${oldKey.slice(from.length)}` : `${textPrefix(dst, newText)}k/${newId()}`;
}

export interface MoveOutcome { from: string; to: string; name: string; comments_deleted: number }

/** SQL: `subject` is an editor or the owner of `project` (placeholders). */
const editorSql = (project: string, subject: string) => `EXISTS (SELECT 1 FROM project_members WHERE project_id = ${project} AND subject = ${subject} AND role IN ('owner', 'editor'))`;

async function mayMove(db: D1Database, subject: string, src: string, dst: string): Promise<boolean> {
  const row = await db.prepare(`SELECT ${editorSql("?1", "?3")} AND ${editorSql("?2", "?3")} AS ok`).bind(src, dst, subject).first<{ ok: number }>();
  return row?.ok === 1;
}

const lostAccess = () => E.forbidden("You are no longer an editor of both projects, so this text was not moved.", "insufficient_role");

const conflict = () => new AppError({ code: "move_conflict", message: "This text changed while it was being moved, so it was not moved. Try again.", status: 409, retryable: true });

/**
 * Move one planned text from `src` to `dst`. Copies first (a failure deletes
 * the copies and leaves the text where it was), then one batch. Returns the
 * new id. Throws 404 if the text left the source meanwhile, 409 move_conflict
 * if it changed, the cap and quota codes if the destination has no room.
 */
export async function moveText(env: Env, subject: string, src: ProjectRow, dst: ProjectRow, plan: TextPlan): Promise<MoveOutcome> {
  const oldId = plan.text.id;
  // The mover's role is checked again before anything is copied (a long request may have lost it since the
  // route authorized it) and once more inside the batch, as the transaction sees the memberships.
  if (!(await mayMove(env.DB, subject, src.id, dst.id))) throw lostAccess();
  const id = newId();
  const map = new Map<string, string>();
  for (const [k] of plan.objects) if (!map.has(k)) map.set(k, movedKey(k, src.id, oldId, dst.id, id));
  const copied: string[] = [];
  const dropCopies = () => (copied.length ? env.FILES.delete(copied).catch(() => undefined) : Promise.resolve());
  try {
    for (const [from, to] of map) {
      const obj = await env.FILES.get(from);
      if (!obj) throw conflict(); // replaced or deleted since the plan was read
      // Buffered, as split and merge copy: a stream body would need a known length, and one object is at most 25 MB.
      await env.FILES.put(to, await obj.arrayBuffer(), { httpMetadata: obj.httpMetadata });
      copied.push(to);
    }
  } catch (error) {
    await dropCopies();
    throw error;
  }

  const t = plan.text;
  const nk = (k: string | null) => (k ? map.get(k) ?? null : null);
  const pairs = JSON.stringify([...map]);
  const now = nowIso();
  const lim = limits(env);
  const prefix = textPrefix(dst.id, id);
  const moved = "EXISTS (SELECT 1 FROM texts WHERE id = ?1)";
  // A row of the new text that names an object outside its prefix was not copied: it changed under the move.
  const stray = (table: string, col: string) => `EXISTS (SELECT 1 FROM ${table} WHERE text_id = ?1 AND ${col} IS NOT NULL AND substr(${col}, 1, length(?3)) != ?3)`;
  const reparent = (table: string, col: string) =>
    env.DB.prepare(
      `UPDATE ${table} SET text_id = ?1, ${col} = CASE WHEN ${col} IS NULL THEN NULL ELSE COALESCE((SELECT json_extract(m.value, '$[1]') FROM json_each(?3) m WHERE json_extract(m.value, '$[0]') = ${table}.${col}), ${col}) END
       WHERE text_id = ?2 AND ${moved}`,
    ).bind(id, oldId, pairs);
  const statements = [
    env.DB.prepare(
      `INSERT INTO texts (id, project_id, name, status, sort_order, summary, source_language, target_language, source_pdf_name, pdf_meta, formula_repair_status,
         html_key, html_bytes, compiled_key, compiled_bytes, translation_key, translation_bytes, source_pdf_key, source_pdf_bytes, source_pdf_revision, search_text, created_at, updated_at)
       SELECT ?1, ?2, name, status, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM texts WHERE project_id = ?2), summary, source_language, target_language, source_pdf_name, pdf_meta, formula_repair_status,
         ?3, html_bytes, ?4, compiled_bytes, ?5, translation_bytes, ?6, source_pdf_bytes, source_pdf_revision, search_text, created_at, ?7
       FROM texts WHERE id = ?8 AND project_id = ?9 AND html_key IS ?10 AND compiled_key IS ?11 AND translation_key IS ?12 AND source_pdf_key IS ?13
         AND EXISTS (SELECT 1 FROM projects WHERE id = ?2) AND ${editorSql("?9", "?14")} AND ${editorSql("?2", "?14")}`,
    ).bind(id, dst.id, nk(t.html_key), nk(t.compiled_key), nk(t.translation_key), nk(t.source_pdf_key), now, oldId, src.id, t.html_key, t.compiled_key, t.translation_key, t.source_pdf_key, subject),
    reparent("pages", "image_key"),
    reparent("figures", "image_key"),
    reparent("text_versions", "r2_key"),
    env.DB.prepare(`UPDATE metadata SET text_id = ?1 WHERE text_id = ?2 AND ${moved}`).bind(id, oldId),
    env.DB.prepare(`UPDATE text_settings SET text_id = ?1 WHERE text_id = ?2 AND ${moved}`).bind(id, oldId),
    // The bytes go to the destination's owner and leave the source's, as this transaction sees both (added first, so
    // the same owner nets zero exactly). They are measured from the rows themselves, now all under the new text.
    env.DB.prepare(`UPDATE profiles SET storage_bytes = storage_bytes + ${textBytesSql("?1")} WHERE subject = ${ownerSql("?2")} AND ${moved}`).bind(id, dst.id),
    env.DB.prepare(`UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - ${textBytesSql("?1")}) WHERE subject = ${ownerSql("?2")} AND ${moved}`).bind(id, src.id),
    // The old row goes, with its comments (cascade) and its search row (trigger).
    env.DB.prepare(`DELETE FROM texts WHERE id = ?2 AND project_id = ?3 AND ${moved}`).bind(id, oldId, src.id),
    env.DB.prepare(`INSERT OR IGNORE INTO r2_cleanup (prefix, created_at) SELECT ?2, ?3 WHERE ${moved}`).bind(id, textPrefix(src.id, oldId), now),
    // A move is an edit of both projects, in the same transaction: the retention sweep re-checks last_edited_at when
    // it deletes, so a project selected for deletion just before the move commits is kept with the text moved into it.
    env.DB.prepare(`UPDATE projects SET last_edited_at = ?2, updated_at = ?2, retention_warned_at = NULL WHERE id IN (?3, ?4) AND ${moved}`).bind(id, now, src.id, dst.id),
    env.DB.prepare(
      `UPDATE profiles SET storage_bytes = -1 WHERE subject = ${ownerSql("?2")} AND ${moved} AND (
         ${stray("pages", "image_key")} OR ${stray("figures", "image_key")} OR ${stray("text_versions", "r2_key")}
         OR EXISTS (SELECT 1 FROM texts WHERE id = ?1 AND (substr(COALESCE(html_key, ?3), 1, length(?3)) != ?3 OR substr(COALESCE(compiled_key, ?3), 1, length(?3)) != ?3
              OR substr(COALESCE(translation_key, ?3), 1, length(?3)) != ?3 OR substr(COALESCE(source_pdf_key, ?3), 1, length(?3)) != ?3))
         OR EXISTS (SELECT 1 FROM pages WHERE text_id = ?4) OR EXISTS (SELECT 1 FROM texts WHERE id = ?4)
         OR (SELECT COUNT(*) FROM texts WHERE project_id = ?2) > ?5
         OR (SELECT COUNT(*) FROM pages p JOIN texts x ON x.id = p.text_id WHERE x.project_id = ?2) > ?6
         OR (${ownerSql("?2")} != ${ownerSql("?7")} AND (SELECT storage_bytes FROM profiles WHERE subject = ${ownerSql("?2")}) > ?8))`,
    ).bind(id, dst.id, prefix, oldId, lim.maxTextsPerProject, lim.maxProjectPages, src.id, lim.storageQuotaBytes),
  ];
  let inserted = 0;
  try {
    const [first] = await env.DB.batch(statements);
    inserted = first?.meta.changes ?? 0;
  } catch (error) {
    await dropCopies();
    if (!/CHECK constraint failed/i.test(String((error as Error)?.message ?? error))) throw error;
    throw await refusal(env, src, dst, plan);
  }
  if (inserted !== 1) {
    await dropCopies();
    const still = await env.DB.prepare("SELECT 1 AS x FROM texts WHERE id = ?1 AND project_id = ?2").bind(oldId, src.id).first();
    if (!still) throw E.notFound("This text is no longer in the project.");
    if (!(await env.DB.prepare("SELECT 1 AS x FROM projects WHERE id = ?1").bind(dst.id).first())) throw E.notFound("The destination project no longer exists.");
    if (!(await mayMove(env.DB, subject, src.id, dst.id))) throw lostAccess();
    throw conflict();
  }
  // Copies of rows deleted while the move ran are referenced by nothing: remove them.
  const referenced = new Set<string | null>();
  const row = await env.DB.prepare("SELECT html_key, compiled_key, translation_key, source_pdf_key FROM texts WHERE id = ?1").bind(id).first<Record<string, string | null>>();
  for (const v of Object.values(row ?? {})) referenced.add(v);
  for (const sql of ["SELECT image_key AS k FROM pages WHERE text_id = ?1", "SELECT image_key AS k FROM figures WHERE text_id = ?1", "SELECT r2_key AS k FROM text_versions WHERE text_id = ?1"]) {
    for (const r of (await env.DB.prepare(sql).bind(id).all<{ k: string | null }>()).results) referenced.add(r.k);
  }
  const unreferenced = copied.filter((k) => !referenced.has(k));
  if (unreferenced.length) await env.FILES.delete(unreferenced).catch(() => undefined);
  await sweepTombstone(env, textPrefix(src.id, oldId));
  await reindexText(env, id);
  return { from: oldId, to: id, name: t.name, comments_deleted: plan.comments };
}

/** Why a guarded batch rolled back, as the error to show (checked after the fact; the numbers may have moved on). */
async function refusal(env: Env, src: ProjectRow, dst: ProjectRow, plan: TextPlan): Promise<AppError> {
  const lim = limits(env);
  const room = await env.DB
    .prepare(
      `SELECT (SELECT COUNT(*) FROM texts WHERE project_id = ?1) AS texts,
              (SELECT COUNT(*) FROM pages p JOIN texts x ON x.id = p.text_id WHERE x.project_id = ?1) AS pages,
              (SELECT storage_bytes FROM profiles WHERE subject = ${ownerSql("?1")}) AS used,
              ${ownerSql("?1")} = ${ownerSql("?2")} AS same_owner`,
    )
    .bind(dst.id, src.id)
    .first<{ texts: number; pages: number; used: number; same_owner: number }>();
  if ((room?.texts ?? 0) + 1 > lim.maxTextsPerProject) return E.conflict(`The destination project can hold at most ${lim.maxTextsPerProject} texts.`, "text_limit_reached");
  if ((room?.pages ?? 0) + plan.pages > lim.maxProjectPages) return E.conflict(`The destination project can hold at most ${lim.maxProjectPages} pages.`, "page_limit_reached");
  if (!room?.same_owner && (room?.used ?? 0) + plan.bytes > lim.storageQuotaBytes) return E.quota("This would exceed the storage allowance of the destination project's owner.");
  return conflict();
}
