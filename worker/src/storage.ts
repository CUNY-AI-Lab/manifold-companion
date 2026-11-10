import { E } from "./errors";
import { projectPrefix } from "./r2-keys";
import type { Env } from "./env";
import { limits } from "./env";

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
 * Delete one row and release `bytesSql` of the owner's quota in ONE atomic batch.
 * The release statement runs first and only if the row still exists, so a second
 * concurrent delete of the same row releases nothing. Returns whether THIS call
 * removed the row.
 */
export async function deleteRowAndRelease(db: D1Database, owner: string, table: "pages" | "figures", id: string, bytesColumn: string): Promise<boolean> {
  const [, del] = await db.batch([
    db.prepare(`UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - COALESCE((SELECT ${bytesColumn} FROM ${table} WHERE id = ?1), 0)) WHERE subject = ?2 AND EXISTS (SELECT 1 FROM ${table} WHERE id = ?1)`).bind(id, owner),
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

/**
 * Atomically add `bytes` to the OWNER's counter, refusing if it would pass the
 * quota. The check and the increment are one statement, so concurrent uploads
 * cannot jointly overshoot.
 */
export async function reserveStorage(env: Env, ownerSubject: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  const quota = limits(env).storageQuotaBytes;
  const result = await env.DB.prepare("UPDATE profiles SET storage_bytes = storage_bytes + ?1 WHERE subject = ?2 AND storage_bytes + ?1 <= ?3")
    .bind(bytes, ownerSubject, quota)
    .run();
  if (result.meta.changes !== 1) throw E.quota("This would exceed the storage allowance for this project's owner.");
}

export async function releaseStorage(db: D1Database, ownerSubject: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  await db.prepare("UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - ?1) WHERE subject = ?2").bind(bytes, ownerSubject).run();
}

/**
 * Delete a project: R2 objects first (so a failure leaves rows that still point
 * at what remains and a retry finishes the job), then one atomic D1 batch that
 * releases the owner's bytes and removes the project (cascading to texts,
 * pages, versions, annotations, members, invites, FTS rows via trigger).
 */
export async function deleteProject(env: Env, projectId: string): Promise<boolean> {
  const project = await env.DB.prepare("SELECT owner_subject FROM projects WHERE id = ?1").bind(projectId).first<{ owner_subject: string }>();
  if (!project) return false;
  await deleteR2Prefix(env.FILES, projectPrefix(projectId));
  // Release and delete in one transaction: the bytes released are the bytes the
  // delete removes, and only the call whose DELETE removes the row releases them.
  const [, del] = await env.DB.batch([
    env.DB.prepare(`UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - ${projectBytesSql("?1")}) WHERE subject = (SELECT owner_subject FROM projects WHERE id = ?1)`).bind(projectId),
    env.DB.prepare("DELETE FROM projects WHERE id = ?1").bind(projectId),
  ]);
  return (del?.meta.changes ?? 0) > 0;
}

/**
 * "Delete my data": every project this person owns (with its objects), then the
 * profile, whose deletion cascades to memberships, annotations, notifications,
 * preferences and invites they created. Content other people own that this
 * person only touched (versions they saved) stays, with the author cleared.
 */
export async function deleteProfileData(env: Env, subject: string): Promise<{ projects: number }> {
  let projects = 0;
  for (;;) {
    const batch = await env.DB.prepare("SELECT id FROM projects WHERE owner_subject = ?1 LIMIT 25").bind(subject).all<{ id: string }>();
    if (batch.results.length === 0) break;
    for (const { id } of batch.results) {
      if (await deleteProject(env, id)) projects += 1;
    }
  }
  await env.DB.prepare("DELETE FROM profiles WHERE subject = ?1").bind(subject).run();
  return { projects };
}
