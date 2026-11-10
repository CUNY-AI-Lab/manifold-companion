import { E } from "./errors";
import { projectPrefix } from "./r2-keys";
import type { Env } from "./env";
import { limits } from "./env";
import { newId, nowIso } from "./util";

// Bytes accounted to one text / one project, as SQL, so a release can be computed
// inside the same D1 batch (transaction) that deletes the rows: the amount released
// is exactly what is removed, once, however many requests race.
export const textBytesSql = (id: string): string =>
  `(COALESCE((SELECT html_bytes + translation_bytes + source_pdf_bytes + compiled_bytes FROM texts WHERE id = ${id}), 0)
  + COALESCE((SELECT SUM(image_bytes) FROM pages WHERE text_id = ${id}), 0)
  + COALESCE((SELECT SUM(bytes) FROM text_versions WHERE text_id = ${id}), 0)
  + COALESCE((SELECT SUM(bytes) FROM figures WHERE text_id = ${id}), 0))`;

export const projectBytesSql = (id: string): string =>
  `(COALESCE((SELECT SUM(t.html_bytes + t.translation_bytes + t.source_pdf_bytes + t.compiled_bytes) FROM texts t WHERE t.project_id = ${id}), 0)
  + COALESCE((SELECT SUM(p.image_bytes) FROM pages p JOIN texts t ON t.id = p.text_id WHERE t.project_id = ${id}), 0)
  + COALESCE((SELECT SUM(v.bytes) FROM text_versions v JOIN texts t ON t.id = v.text_id WHERE t.project_id = ${id}), 0)
  + COALESCE((SELECT SUM(f.bytes) FROM figures f JOIN texts t ON t.id = f.text_id WHERE t.project_id = ${id}), 0))`;

/**
 * The subject a counter change for project `?n` applies to: its owner as the
 * transaction sees it, never an owner read earlier in the request. Ownership
 * can move between a request's authorization and its writes (a transfer
 * accepted meanwhile), and the bytes belong to whoever owns the rows now.
 */
export const ownerSql = (placeholder: string): string => `(SELECT owner_subject FROM projects WHERE id = ${placeholder})`;

/**
 * Delete one row of project `projectId` and release its bytes from the
 * project's current owner in ONE atomic batch. The release statement runs first
 * and only if the row still exists, so a second concurrent delete of the same
 * row releases nothing. Returns whether THIS call removed the row.
 */
export async function deleteRowAndRelease(db: D1Database, projectId: string, table: "pages" | "figures", id: string, bytesColumn: string): Promise<boolean> {
  const [, del] = await db.batch([
    db.prepare(`UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - COALESCE((SELECT ${bytesColumn} FROM ${table} WHERE id = ?1), 0)) WHERE subject = ${ownerSql("?2")} AND EXISTS (SELECT 1 FROM ${table} WHERE id = ?1)`).bind(id, projectId),
    db.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id),
  ]);
  return (del?.meta.changes ?? 0) > 0;
}

/** Delete every object under a prefix. Resumable: safe to call again after a failure. */
export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length === 0) break;
    await bucket.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
    if (!page.truncated) break;
  }
  return deleted;
}

/** Bytes of R2 content this project's rows account for. */
export async function projectStorageBytes(db: D1Database, projectId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
        COALESCE((SELECT SUM(t.html_bytes + t.translation_bytes + t.source_pdf_bytes + t.compiled_bytes) FROM texts t WHERE t.project_id = ?1), 0) +
        COALESCE((SELECT SUM(p.image_bytes) FROM pages p JOIN texts t ON t.id = p.text_id WHERE t.project_id = ?1), 0) +
        COALESCE((SELECT SUM(v.bytes) FROM text_versions v JOIN texts t ON t.id = v.text_id WHERE t.project_id = ?1), 0) +
        COALESCE((SELECT SUM(f.bytes) FROM figures f JOIN texts t ON t.id = f.text_id WHERE t.project_id = ?1), 0) AS bytes`,
    )
    .bind(projectId)
    .first<{ bytes: number }>();
  return row?.bytes ?? 0;
}

/** A reservation outlives the longest possible request; one abandoned by an interrupted Worker then expires. */
export const RESERVATION_TTL_MS = 60 * 60 * 1000;

/**
 * Quota held for bytes of one project not yet recorded in a row. Commit it in
 * the batch that writes the row; release it otherwise. The row in
 * `storage_reservations` says whose counter holds it (`subject`, the project's
 * owner, moved by an ownership transfer) and for which project.
 */
export interface Reservation { id: string; projectId: string; bytes: number }

/** Bytes reserved for project `?n` and not yet in its rows: part of what a transfer moves. */
export const projectReservedSql = (placeholder: string): string =>
  `COALESCE((SELECT SUM(bytes) FROM storage_reservations WHERE project_id = ${placeholder} AND subject = ${ownerSql(placeholder)}), 0)`;

/**
 * Reserve `bytes` for project `projectId` on its owner's counter (the owner as
 * this transaction sees it), refusing if it would pass the quota. One
 * transaction: the reservation row is inserted only if the bytes fit, and the
 * counter rises only if THIS reservation row exists. Concurrent reservations
 * are serialized by D1, so they cannot jointly overshoot.
 */
export async function reserveStorage(env: Env, projectId: string, bytes: number): Promise<Reservation | null> {
  if (bytes <= 0) return null;
  const quota = limits(env).storageQuotaBytes;
  const id = newId();
  const now = Date.now();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO storage_reservations (id, subject, project_id, bytes, created_at, expires_at)
       SELECT ?1, pr.owner_subject, pr.id, ?3, ?4, ?5 FROM projects pr JOIN profiles pf ON pf.subject = pr.owner_subject
       WHERE pr.id = ?2 AND pf.storage_bytes + ?3 <= ?6`,
    ).bind(id, projectId, bytes, nowIso(now), nowIso(now + RESERVATION_TTL_MS), quota),
    env.DB.prepare("UPDATE profiles SET storage_bytes = storage_bytes + ?2 WHERE subject = (SELECT subject FROM storage_reservations WHERE id = ?1)").bind(id, bytes),
  ]);
  if (inserted?.meta.changes !== 1) {
    const exists = await env.DB.prepare("SELECT 1 AS x FROM projects WHERE id = ?1").bind(projectId).first();
    if (!exists) throw E.notFound("Project not found.");
    throw E.quota("This would exceed the storage allowance for this project's owner.");
  }
  return { id, projectId, bytes };
}

/**
 * The statements that commit a reservation, for the batch that writes its row.
 * Both run only if `rowExistsSql` holds, i.e. only if that same batch really
 * wrote the row (placeholders in `rowExistsSql` start at ?2), in this order:
 *   1. if the reservation is gone, charge the project's owner for the bytes.
 *      It is gone only if the request outlived RESERVATION_TTL_MS and the
 *      recount dropped it (and its bytes) meanwhile. Upload bodies have a read
 *      deadline far below the TTL (src/body.ts readDeadlineMs), so this is a
 *      backstop for a request stalled elsewhere; without it the row would be
 *      stored and never paid for.
 *   2. delete the reservation: the counter already holds the bytes, now
 *      accounted by the row.
 */
export function commitReservation(db: D1Database, r: Reservation | null, rowExistsSql: string, ...binds: unknown[]): D1PreparedStatement[] {
  if (!r) return [];
  const n = binds.length;
  return [
    db.prepare(`UPDATE profiles SET storage_bytes = storage_bytes + ?${n + 2} WHERE subject = ${ownerSql(`?${n + 3}`)} AND NOT EXISTS (SELECT 1 FROM storage_reservations WHERE id = ?1) AND ${rowExistsSql}`).bind(r.id, ...binds, r.bytes, r.projectId),
    db.prepare(`DELETE FROM storage_reservations WHERE id = ?1 AND ${rowExistsSql}`).bind(r.id, ...binds),
  ];
}

/**
 * Give a reservation back: the counter that holds it (the reservation's
 * subject, which a transfer may have moved) drops only if the reservation still
 * exists, once.
 */
export async function releaseReservation(db: D1Database, r: Reservation | null): Promise<void> {
  if (!r) return;
  await db.batch([
    db.prepare("UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - ?2) WHERE subject = (SELECT subject FROM storage_reservations WHERE id = ?1)").bind(r.id, r.bytes),
    db.prepare("DELETE FROM storage_reservations WHERE id = ?1").bind(r.id),
  ]);
}

/**
 * Lower the counter of project `projectId`'s current owner by bytes that rows
 * no longer account for, as a statement for the batch that changed the rows.
 * Placeholders in `whenSql` start at ?3.
 */
export function releaseStatement(db: D1Database, projectId: string, bytes: number, whenSql: string, ...binds: unknown[]): D1PreparedStatement[] {
  if (bytes <= 0) return [];
  return [db.prepare(`UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - ?1) WHERE subject = ${ownerSql("?2")} AND ${whenSql}`).bind(bytes, projectId, ...binds)];
}

// The recount, as fixed SQL (no runtime values in the text; `?1` is the time
// that separates live from expired reservations). `own` is the owned project
// (projectBytesSql uses t, p, v and f inside).
const OWNED_BYTES_SQL = `(SELECT COALESCE(SUM(${projectBytesSql("own.id")}), 0) FROM projects own WHERE own.owner_subject = profiles.subject)`;
const LIVE_RESERVED_SQL = "(SELECT COALESCE(SUM(r.bytes), 0) FROM storage_reservations r WHERE r.subject = profiles.subject AND r.expires_at > ?1)";
const RECOUNT_SQL = `UPDATE profiles SET storage_bytes = ${OWNED_BYTES_SQL} + ${LIVE_RESERVED_SQL} WHERE storage_bytes != ${OWNED_BYTES_SQL} + ${LIVE_RESERVED_SQL}`;

/**
 * Daily backstop: expired reservations (left by an interrupted Worker) are
 * deleted, then every counter is set to rows + live reservations, the
 * invariant. Because a live reservation is part of the formula, an upload in
 * progress keeps its quota. Returns how many counters changed.
 */
export async function recountStorage(env: Env, nowMs = Date.now()): Promise<number> {
  const now = nowIso(nowMs);
  const [, recount] = await env.DB.batch([
    env.DB.prepare("DELETE FROM storage_reservations WHERE expires_at <= ?1").bind(now),
    env.DB.prepare(RECOUNT_SQL).bind(now),
  ]);
  return recount?.meta.changes ?? 0;
}

/**
 * A guard on the project row: SQL over `projects` columns whose placeholders
 * are written `?G1`, `?G2`, ... and renumbered per statement. The delete
 * happens only if the guard still holds inside the deleting transaction.
 */
export interface DeleteGuard {
  sql: string;
  binds: unknown[];
}

function guardAt(guard: DeleteGuard | undefined, first: number): string {
  return guard ? ` AND (${guard.sql.replace(/\?G(\d+)/g, (_m, n: string) => `?${first + Number(n) - 1}`)})` : "";
}

/**
 * Delete a project. ONE D1 batch (one transaction) re-checks the row (and the
 * optional guard), releases the owner's bytes, records a cleanup tombstone for
 * the project's R2 prefix and deletes the rows (cascading to texts, pages,
 * versions, annotations, members, invites; FTS rows by trigger). Only then are
 * the objects swept. A failed or interrupted sweep leaves the tombstone, and
 * the daily cron sweeps every tombstone again (which also removes an object an
 * upload in flight wrote after the first sweep) before forgetting it.
 *
 * Rows go first so a guarded delete (retention) can never destroy the files of
 * a project that was edited after it was selected: if the guard fails, nothing
 * has been touched.
 */
export async function deleteProject(env: Env, projectId: string, guard?: DeleteGuard): Promise<boolean> {
  const binds = guard?.binds ?? [];
  const prefix = projectPrefix(projectId);
  const now = nowIso();
  const [, , del] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - ${projectBytesSql("?1")})
       WHERE subject = (SELECT owner_subject FROM projects WHERE id = ?1) AND EXISTS (SELECT 1 FROM projects WHERE id = ?1${guardAt(guard, 2)})`,
    ).bind(projectId, ...binds),
    env.DB.prepare(`INSERT OR IGNORE INTO r2_cleanup (prefix, created_at) SELECT ?2, ?3 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1${guardAt(guard, 4)})`).bind(projectId, prefix, now, ...binds),
    env.DB.prepare(`DELETE FROM projects WHERE id = ?1${guardAt(guard, 2)}`).bind(projectId, ...binds),
  ]);
  if ((del?.meta.changes ?? 0) === 0) return false;
  await sweepTombstone(env, prefix);
  return true;
}

/** Sweep one tombstoned prefix now. Failure is left to the cron: the tombstone stays. */
export async function sweepTombstone(env: Env, prefix: string): Promise<boolean> {
  try {
    await deleteR2Prefix(env.FILES, prefix);
    await env.DB.prepare("UPDATE r2_cleanup SET swept_at = ?1 WHERE prefix = ?2").bind(nowIso(), prefix).run();
    return true;
  } catch {
    return false;
  }
}

/** Tombstones are kept this long after creation so the cron sweeps each one at least once more. */
export const TOMBSTONE_KEEP_MS = 86_400_000;

/**
 * Cron: sweep every tombstone (bounded), then forget the ones that are older
 * than a day and were swept after that day began. Returns [swept, failed].
 */
export async function processCleanup(env: Env, nowMs = Date.now(), limit = 100): Promise<{ swept: number; failed: number }> {
  const rows = await env.DB.prepare("SELECT prefix, created_at FROM r2_cleanup ORDER BY created_at LIMIT ?1").bind(limit).all<{ prefix: string; created_at: string }>();
  let swept = 0;
  let failed = 0;
  const forgetBefore = nowIso(nowMs - TOMBSTONE_KEEP_MS);
  for (const row of rows.results) {
    try {
      await deleteR2Prefix(env.FILES, row.prefix);
      swept += 1;
      if (row.created_at < forgetBefore) await env.DB.prepare("DELETE FROM r2_cleanup WHERE prefix = ?1").bind(row.prefix).run();
      else await env.DB.prepare("UPDATE r2_cleanup SET swept_at = ?1 WHERE prefix = ?2").bind(nowIso(nowMs), row.prefix).run();
    } catch {
      failed += 1;
    }
  }
  return { swept, failed };
}

/** A delete guard: the project is still owned by `subject` inside the deleting transaction. */
export const ownedBy = (subject: string): DeleteGuard => ({ sql: "owner_subject = ?G1", binds: [subject] });

/**
 * "Delete my data": every project this person owns (with its objects), then the
 * profile, whose deletion cascades to memberships, annotations, notifications,
 * preferences and invites they created. Content other people own that this
 * person only touched (versions they saved) stays, with the author cleared.
 *
 * Ownership can move while this runs (a transfer accepted by or from this
 * person), so each project is deleted only if this person still owns it in the
 * deleting transaction, and the profile only once it owns nothing: a project
 * left to the profile's cascade would lose its rows without a tombstone, and
 * its objects would never be swept.
 */
export async function deleteProfileData(env: Env, subject: string): Promise<{ projects: number }> {
  let projects = 0;
  for (let round = 0; round < 5; round += 1) {
    for (;;) {
      const batch = await env.DB.prepare("SELECT id FROM projects WHERE owner_subject = ?1 LIMIT 25").bind(subject).all<{ id: string }>();
      if (batch.results.length === 0) break;
      for (const { id } of batch.results) {
        if (await deleteProject(env, id, ownedBy(subject))) projects += 1;
      }
    }
    const gone = await env.DB.prepare("DELETE FROM profiles WHERE subject = ?1 AND NOT EXISTS (SELECT 1 FROM projects WHERE owner_subject = ?1)").bind(subject).run();
    if (gone.meta.changes === 1) return { projects };
    const left = await env.DB.prepare("SELECT 1 AS x FROM profiles WHERE subject = ?1").bind(subject).first();
    if (!left) return { projects };
  }
  throw E.conflict("Your projects changed while they were being deleted. Try again.", "retry");
}
