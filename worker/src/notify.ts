// In-app notifications only (no email: see docs/DESIGN.md, Email). Every
// notification is addressed to an opaque subject and respects that person's
// in-app preference for its type. Nothing here knows or stores an address.
import { newId, nowIso } from "./util";

export type NotificationType = "comment_reply" | "comment_mention" | "project_shared" | "retention_warning";
const PREF: Partial<Record<NotificationType, string>> = { comment_reply: "inapp_comment_reply", comment_mention: "inapp_comment_mention", project_shared: "inapp_project_shared" };
/** Each person keeps at most this many notifications; older ones are pruned on insert. */
export const MAX_NOTIFICATIONS_PER_PERSON = 500;

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
}

const preview = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n)}...` : s);
export const bodyPreview = preview;

/** Notify each subject (excluding `actor`), honouring preferences, as one batch. */
export async function notify(db: D1Database, subjects: string[], actor: string | null, n: NotificationInput): Promise<number> {
  const targets = [...new Set(subjects)].filter((s) => s !== actor).slice(0, 50);
  if (targets.length === 0) return 0;
  const pref = PREF[n.type];
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const subject of targets) {
    statements.push(
      db.prepare(
        `INSERT INTO notifications (id, subject, type, title, body, link, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM profiles WHERE subject = ?2)
           ${pref ? `AND COALESCE((SELECT ${pref} FROM notification_preferences WHERE subject = ?2), 1) = 1` : ""}`,
      ).bind(newId(), subject, n.type, preview(n.title, 200), n.body ? preview(n.body, 300) : null, n.link ?? null, now),
      db.prepare(
        `DELETE FROM notifications WHERE subject = ?1 AND id IN (
           SELECT id FROM notifications WHERE subject = ?1 ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?2)`,
      ).bind(subject, MAX_NOTIFICATIONS_PER_PERSON),
    );
  }
  const results = await db.batch(statements);
  return results.filter((_, i) => i % 2 === 0).reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}
