import { limits, type Env } from "./env";
import { deleteProject } from "./storage";
import { addDays, newId, nowIso } from "./util";

/** A project must have been warned at least this long before it may be deleted. */
export const MIN_WARNING_DAYS = 7;
const BATCH = 50;

export interface SweepResult {
  warned: number;
  deleted: number;
  failed: number;
}

/**
 * Daily sweep. Two phases, in this order:
 *  1. warn: any project whose last edit is older than (retention - warn window)
 *     and not yet warned gets one in-app notification to its owner and a
 *     `retention_warned_at` stamp. Any edit clears the stamp and restarts the clock.
 *  2. delete: any project past retention that was warned at least MIN_WARNING_DAYS
 *     ago. A project that was never warned (cron outage, import) is warned first
 *     and deleted a week later, so nobody loses work without a visible warning.
 */
export async function runRetentionSweep(env: Env, nowMs = Date.now()): Promise<SweepResult> {
  const lim = limits(env);
  const now = nowIso(nowMs);
  const warnCutoff = addDays(now, -(lim.retentionDays - lim.retentionWarnDays));
  const deleteCutoff = addDays(now, -lim.retentionDays);
  const warnedBefore = addDays(now, -MIN_WARNING_DAYS);
  const result: SweepResult = { warned: 0, deleted: 0, failed: 0 };

  const toWarn = await env.DB.prepare(
    "SELECT id, owner_subject, name, last_edited_at FROM projects WHERE last_edited_at < ?1 AND retention_warned_at IS NULL LIMIT ?2",
  )
    .bind(warnCutoff, BATCH)
    .all<{ id: string; owner_subject: string; name: string; last_edited_at: string }>();
  for (const p of toWarn.results) {
    const deleteOn = addDays(p.last_edited_at, lim.retentionDays);
    await env.DB.batch([
      env.DB.prepare("UPDATE projects SET retention_warned_at = ?1 WHERE id = ?2 AND last_edited_at = ?3").bind(now, p.id, p.last_edited_at),
      env.DB.prepare("INSERT INTO notifications (id, subject, type, title, body, link, created_at) VALUES (?1,?2,'retention_warning',?3,?4,?5,?6)").bind(
        newId(),
        p.owner_subject,
        "Project scheduled for deletion",
        `"${p.name.slice(0, 80)}" has not been edited for a long time and will be deleted on ${deleteOn.slice(0, 10)} unless you edit it or download your work.`,
        `/projects/${p.id}`,
        now,
      ),
    ]);
    result.warned += 1;
  }

  const toDelete = await env.DB.prepare("SELECT id FROM projects WHERE last_edited_at < ?1 AND retention_warned_at IS NOT NULL AND retention_warned_at <= ?2 LIMIT ?3")
    .bind(deleteCutoff, warnedBefore, BATCH)
    .all<{ id: string }>();
  for (const { id } of toDelete.results) {
    try {
      if (await deleteProject(env, id)) result.deleted += 1;
    } catch {
      result.failed += 1; // R2 or D1 hiccup: rows remain, tomorrow's sweep retries.
    }
  }
  return result;
}
