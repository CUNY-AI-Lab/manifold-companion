// The signed-in person's own in-app notifications. Subject-scoped: every
// statement binds the verified subject; no route takes a subject.
import { Hono } from "hono";
import { readJsonObject } from "../body";
import { E } from "../errors";
import { isUuid } from "../util";
import type { AppEnv } from "../app";

export const notificationRoutes = new Hono<AppEnv>();
const PREFS = ["inapp_project_shared", "inapp_comment_reply", "inapp_comment_mention"] as const;

notificationRoutes.get("/", async (c) => {
  const { subject } = c.get("principal");
  const all = c.req.query("all") === "1";
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const rows = await c.env.DB.prepare(`SELECT id, type, title, body, link, read, created_at FROM notifications WHERE subject = ?1 ${all ? "" : "AND read = 0"} ORDER BY created_at DESC, rowid DESC LIMIT ?2`).bind(subject, limit).all<{ read: number }>();
  const unread = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE subject = ?1 AND read = 0").bind(subject).first<{ n: number }>();
  return c.json({ notifications: rows.results.map((n) => ({ ...n, read: n.read === 1 })), unread: unread?.n ?? 0 });
});

notificationRoutes.get("/unread-count", async (c) => {
  const unread = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE subject = ?1 AND read = 0").bind(c.get("principal").subject).first<{ n: number }>();
  return c.json({ unread: unread?.n ?? 0 });
});

notificationRoutes.post("/read-all", async (c) => {
  await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE subject = ?1 AND read = 0").bind(c.get("principal").subject).run();
  return c.json({ ok: true });
});

notificationRoutes.post("/:nid/read", async (c) => {
  const nid = c.req.param("nid");
  if (!isUuid(nid)) throw E.notFound("Notification not found.");
  const res = await c.env.DB.prepare("UPDATE notifications SET read = 1 WHERE id = ?1 AND subject = ?2").bind(nid, c.get("principal").subject).run();
  if (res.meta.changes !== 1) throw E.notFound("Notification not found.");
  return c.json({ ok: true });
});

async function prefsOf(db: D1Database, subject: string) {
  const row = await db.prepare(`SELECT ${PREFS.join(", ")} FROM notification_preferences WHERE subject = ?1`).bind(subject).first<Record<string, number>>();
  // Email is not sent at launch (in-app only), so no email preference is offered.
  return Object.fromEntries(PREFS.map((k) => [k, (row?.[k] ?? 1) === 1]));
}

notificationRoutes.get("/preferences", async (c) => c.json({ preferences: await prefsOf(c.env.DB, c.get("principal").subject) }));

notificationRoutes.put("/preferences", async (c) => {
  const { subject } = c.get("principal");
  const body = await readJsonObject(c.req.raw, 4096);
  const sets: string[] = [];
  const values: number[] = [];
  for (const k of PREFS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== "boolean") throw E.badRequest(`${k} must be true or false.`);
    sets.push(`${k} = ?${values.length + 2}`);
    values.push(body[k] ? 1 : 0);
  }
  if (sets.length === 0) throw E.badRequest("Nothing to update.");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO notification_preferences (subject) VALUES (?1)").bind(subject),
    c.env.DB.prepare(`UPDATE notification_preferences SET ${sets.join(", ")} WHERE subject = ?1`).bind(subject, ...values),
  ]);
  return c.json({ preferences: await prefsOf(c.env.DB, subject) });
});
