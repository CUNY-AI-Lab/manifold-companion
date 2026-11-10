import { limits, type Env } from "./env";
import { deleteProject, processCleanup, recountStorage } from "./storage";
import { addDays, nowIso, UUID_V4_SQL } from "./util";

/** A project must have been warned at least this long before it may be deleted. */
export const MIN_WARNING_DAYS = 7;
const BATCH = 50;

export interface SweepResult {
  warned: number;
  deleted: number;
  failed: number;
  /** R2 prefixes of deleted projects/texts swept again (tombstones). */
  cleaned: number;
  /** Storage counters corrected to what the rows account for. */
  reconciled: number;
}



/**
 * Daily sweep. All times are UTC ISO-8601 strings in one fixed format
 * (`nowIso`, no milliseconds), so string comparison is time comparison.
 *
 *  1. warn: a project whose last edit is older than (retention - warn window)
 *     and not yet warned gets `retention_warned_at` and one in-app notification
 *     for each owner and editor (anyone who can keep it alive by editing). The
 *     stamp is a compare-and-set on `last_edited_at`, and the notifications are
 *     inserted only if THIS stamp landed, so a project edited meanwhile gets no
 *     spurious warning. Any edit clears the stamp and restarts the clock.
 *  2. delete: a project past retention that was warned at least MIN_WARNING_DAYS
 *     ago. The same condition is re-checked inside the deleting transaction, and
 *     rows go before objects, so an edit that lands after the selection keeps
 *     the project and every one of its files.
 *  3. cleanup: tombstoned R2 prefixes are swept again.
 *  4. recount: expired storage reservations (left by an interrupted Worker)
 *     are dropped and every counter is set to rows + live reservations
 *     (recountStorage), so a leak is corrected and an upload in progress keeps
 *     its quota.
 */
export async function runRetentionSweep(env: Env, nowMs = Date.now()): Promise<SweepResult> {
  const lim = limits(env);
  const now = nowIso(nowMs);
  const warnCutoff = addDays(now, -(lim.retentionDays - lim.retentionWarnDays));
  const deleteCutoff = addDays(now, -lim.retentionDays);
  const warnedBefore = addDays(now, -MIN_WARNING_DAYS);
  const result: SweepResult = { warned: 0, deleted: 0, failed: 0, cleaned: 0, reconciled: 0 };

  const toWarn = await env.DB.prepare(
    "SELECT id, name, last_edited_at FROM projects WHERE last_edited_at < ?1 AND retention_warned_at IS NULL ORDER BY last_edited_at LIMIT ?2",
  )
    .bind(warnCutoff, BATCH)
    .all<{ id: string; name: string; last_edited_at: string }>();
  for (const p of toWarn.results) {
    const deleteOn = addDays(p.last_edited_at, lim.retentionDays).slice(0, 10);
    const [stamp] = await env.DB.batch([
      env.DB.prepare("UPDATE projects SET retention_warned_at = ?1 WHERE id = ?2 AND last_edited_at = ?3 AND retention_warned_at IS NULL").bind(now, p.id, p.last_edited_at),
      env.DB.prepare(
        `INSERT INTO notifications (id, subject, type, title, body, link, created_at)
         SELECT ${UUID_V4_SQL}, m.subject, 'retention_warning', ?1, ?2, ?3, ?4
         FROM project_members m
         WHERE m.project_id = ?5 AND m.role IN ('owner', 'editor')
           AND EXISTS (SELECT 1 FROM projects WHERE id = ?5 AND retention_warned_at = ?4 AND last_edited_at = ?6)`,
      ).bind(
        "Project scheduled for deletion",
        `"${p.name.slice(0, 80)}" has not been edited for a long time and will be deleted on ${deleteOn} (UTC) unless someone edits it or you export your work.`,
        `/projects/${p.id}`,
        now,
        p.id,
        p.last_edited_at,
      ),
    ]);
    if (stamp?.meta.changes === 1) result.warned += 1;
  }

  const toDelete = await env.DB.prepare(
    "SELECT id FROM projects WHERE last_edited_at < ?1 AND retention_warned_at IS NOT NULL AND retention_warned_at <= ?2 ORDER BY last_edited_at LIMIT ?3",
  )
    .bind(deleteCutoff, warnedBefore, BATCH)
    .all<{ id: string }>();
  for (const { id } of toDelete.results) {
    try {
      const guard = { sql: "last_edited_at < ?G1 AND retention_warned_at IS NOT NULL AND retention_warned_at <= ?G2", binds: [deleteCutoff, warnedBefore] };
      if (await deleteProject(env, id, guard)) result.deleted += 1;
    } catch {
      result.failed += 1; // D1 hiccup: nothing was deleted; tomorrow's sweep retries.
    }
  }

  const cleanup = await processCleanup(env, nowMs);
  result.cleaned = cleanup.swept;
  result.failed += cleanup.failed;

  try {
    result.reconciled = await recountStorage(env, nowMs);
  } catch {
    result.failed += 1;
  }
  return result;
}
