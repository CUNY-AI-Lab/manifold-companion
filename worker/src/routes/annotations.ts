// Annotations (threaded comments) on a text, mounted at /texts. Legacy roles
// (server/routes/annotations.js): viewers read; editors create, reply,
// resolve and unresolve; anyone with access edits their OWN comments; the
// author or the project owner deletes. Legacy bugs fixed here:
//   - a reply's parent must be a comment on the SAME text (legacy accepted any
//     annotation id, threading a comment under another text or project);
//     replying to a reply attaches to its thread's root;
//   - anchor_data is bounded (legacy stored any JSON);
//   - mentions must be current members of the project; anything else is
//     refused rather than silently dropped. Members are identified by subject
//     and self-set display name only.
import { Hono } from "hono";
import { requireTextRole } from "../authz";
import { readJsonObject } from "../body";
import { byteLength, touchProject } from "../content";
import { E } from "../errors";
import { bodyPreview, notify } from "../notify";
import { isSubject, isUuid, newId, nowIso } from "../util";
import type { AppEnv } from "../app";

export const annotationRoutes = new Hono<AppEnv>();
const idOf = (c: { req: { param: (n: string) => string | undefined } }): string => c.req.param("id") as string;

export const ANNOTATION_LIMITS = { bodyChars: 10_000, anchorBytes: 4096, mentions: 20 } as const;
const ANCHORS = new Set(["range", "point", "global"]);

interface AnnotationRow {
  id: string;
  text_id: string;
  author_subject: string;
  author_name: string | null;
  parent_id: string | null;
  anchor_type: string;
  anchor_data: string | null;
  body: string;
  mentions: string;
  resolved: number;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  reply_count?: number;
}

const SELECT = `SELECT a.*, p.display_name AS author_name FROM annotations a LEFT JOIN profiles p ON p.subject = a.author_subject`;

function present(a: AnnotationRow, me: string) {
  let anchor: unknown = null;
  let mentions: unknown = [];
  try { anchor = a.anchor_data === null ? null : JSON.parse(a.anchor_data); } catch { anchor = null; }
  try { mentions = JSON.parse(a.mentions); } catch { mentions = []; }
  return { ...a, anchor_data: anchor, mentions, resolved: a.resolved === 1, mine: a.author_subject === me };
}

function bodyOf(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") throw E.badRequest("Annotation body is required.");
  if (raw.length > ANNOTATION_LIMITS.bodyChars) throw E.badRequest(`Comment is too long (max ${ANNOTATION_LIMITS.bodyChars.toLocaleString("en-US")} characters).`, "comment_too_long");
  return raw.trim();
}

async function membersOf(db: D1Database, projectId: string): Promise<Map<string, string | null>> {
  const rows = await db.prepare("SELECT m.subject, p.display_name FROM project_members m JOIN profiles p ON p.subject = m.subject WHERE m.project_id = ?1").bind(projectId).all<{ subject: string; display_name: string | null }>();
  return new Map(rows.results.map((r) => [r.subject, r.display_name]));
}

async function mentionsOf(db: D1Database, projectId: string, raw: unknown): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > ANNOTATION_LIMITS.mentions || raw.some((s) => typeof s !== "string" || !isSubject(s))) {
    throw E.badRequest(`mentions must be a list of at most ${ANNOTATION_LIMITS.mentions} member ids.`, "mention_invalid");
  }
  const unique = [...new Set(raw as string[])];
  if (unique.length === 0) return [];
  const members = await membersOf(db, projectId);
  if (unique.some((s) => !members.has(s))) throw E.badRequest("You can only mention people who are members of this project.", "mention_not_member");
  return unique;
}

async function loadAnnotation(db: D1Database, textId: string, raw: string | undefined): Promise<AnnotationRow> {
  if (!raw || !isUuid(raw)) throw E.notFound("Annotation not found.");
  const row = await db.prepare(`${SELECT} WHERE a.id = ?1 AND a.text_id = ?2`).bind(raw, textId).first<AnnotationRow>();
  if (!row) throw E.notFound("Annotation not found.");
  return row;
}

async function create(c: { env: AppEnv["Bindings"]; get: (k: "principal") => { subject: string } }, ctx: Awaited<ReturnType<typeof requireTextRole>>, input: { anchorType: string; anchorData: string | null; body: string; parentId: string | null; mentions: string[] }) {
  const me = c.get("principal").subject;
  const id = newId();
  const now = nowIso();
  // The parent is re-checked inside the insert: it must still exist on this text.
  const res = await c.env.DB.prepare(
    `INSERT INTO annotations (id, text_id, author_subject, parent_id, anchor_type, anchor_data, body, mentions, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9
     WHERE ?4 IS NULL OR EXISTS (SELECT 1 FROM annotations WHERE id = ?4 AND text_id = ?2 AND parent_id IS NULL)`,
  ).bind(id, ctx.text.id, me, input.parentId, input.anchorType, input.anchorData, input.body, JSON.stringify(input.mentions), now).run();
  if (res.meta.changes !== 1) throw E.notFound("Parent annotation not found.");
  await touchProject(c.env.DB, ctx.project.id, now);
  return id;
}

/**
 * A comment on a stretch of text (W3C text-quote plus text-position selector):
 * the quoted text, up to 64 characters on either side, the offsets where it was,
 * and for image texts the page it is on. Only these keys, only these types, all
 * bounded; the client shows them as plain text and re-finds the quote itself.
 */
export const RANGE_LIMITS = { quote: 1000, context: 64, offset: 10_000_000 } as const;
async function rangeAnchor(db: D1Database, textId: string, raw: unknown): Promise<Record<string, unknown>> {
  const bad = (why: string) => E.badRequest(`A range comment needs ${why}.`, "anchor_invalid");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw bad("anchor_data");
  const a = raw as Record<string, unknown>;
  const str = (k: string, max: number, min = 0): string => {
    const v = a[k] ?? "";
    if (typeof v !== "string" || v.length > max || v.length < min) throw bad(`${k} as text of at most ${max} characters`);
    return v;
  };
  const int = (k: string): number => {
    const v = a[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > RANGE_LIMITS.offset) throw bad(`${k} as a position`);
    return v;
  };
  const quote = str("quote", RANGE_LIMITS.quote, 1);
  if (quote.trim() === "") throw bad("a quote that is not only spaces");
  const out: Record<string, unknown> = { quote, prefix: str("prefix", RANGE_LIMITS.context), suffix: str("suffix", RANGE_LIMITS.context), start: int("start"), end: int("end") };
  if ((out.end as number) < (out.start as number)) throw bad("end at or after start");
  if (a.page_id !== undefined && a.page_id !== null) {
    if (typeof a.page_id !== "string" || !isUuid(a.page_id)) throw bad("page_id as a page of this text");
    const page = await db.prepare("SELECT 1 AS x FROM pages WHERE id = ?1 AND text_id = ?2").bind(a.page_id, textId).first();
    if (!page) throw bad("page_id as a page of this text");
    out.page_id = a.page_id;
  }
  const extra = Object.keys(a).filter((k) => !["quote", "prefix", "suffix", "start", "end", "page_id"].includes(k));
  if (extra.length) throw bad("only quote, prefix, suffix, start, end and page_id");
  return out;
}

const linkFor = (textId: string) => `/texts/${textId}?tab=review&annotations=1`;

annotationRoutes.get("/:id/mentions", async (c) => {
  const ctx = await requireTextRole(c.env.DB, c.get("principal").subject, idOf(c), "viewer");
  const members = await membersOf(c.env.DB, ctx.project.id);
  return c.json({ users: [...members].map(([subject, display_name]) => ({ subject, display_name })) });
});

annotationRoutes.get("/:id/annotations", async (c) => {
  const me = c.get("principal").subject;
  const ctx = await requireTextRole(c.env.DB, me, idOf(c), "viewer");
  const includeResolved = c.req.query("resolved") === "1";
  const rows = await c.env.DB.prepare(
    `SELECT a.*, p.display_name AS author_name, (SELECT COUNT(*) FROM annotations r WHERE r.parent_id = a.id) AS reply_count
     FROM annotations a LEFT JOIN profiles p ON p.subject = a.author_subject
     WHERE a.text_id = ?1 AND a.parent_id IS NULL ${includeResolved ? "" : "AND a.resolved = 0"}
     ORDER BY a.created_at, a.rowid LIMIT 500`,
  ).bind(ctx.text.id).all<AnnotationRow>();
  const members = await membersOf(c.env.DB, ctx.project.id);
  return c.json({ annotations: rows.results.map((a) => present(a, me)), mentioned_users: Object.fromEntries([...members].map(([s, n]) => [s, { display_name: n }])) });
});

annotationRoutes.post("/:id/annotations", async (c) => {
  const me = c.get("principal").subject;
  const ctx = await requireTextRole(c.env.DB, me, idOf(c), "editor");
  const body = await readJsonObject(c.req.raw, 64 * 1024);
  const text = bodyOf(body.body);
  if (typeof body.anchor_type !== "string" || !ANCHORS.has(body.anchor_type)) throw E.badRequest("Valid anchor_type is required (range, point, or global).");
  let anchorData: string | null = null;
  if (body.anchor_type === "range") {
    anchorData = JSON.stringify(await rangeAnchor(c.env.DB, ctx.text.id, body.anchor_data));
  } else if (body.anchor_data !== undefined && body.anchor_data !== null) {
    if (typeof body.anchor_data !== "object" && typeof body.anchor_data !== "string") throw E.badRequest("anchor_data must be an object.", "anchor_invalid");
    anchorData = JSON.stringify(body.anchor_data);
    if (byteLength(anchorData) > ANNOTATION_LIMITS.anchorBytes) throw E.tooLarge(`anchor_data can be at most ${ANNOTATION_LIMITS.anchorBytes} bytes.`, "anchor_too_large");
  }
  let parentId: string | null = null;
  let parent: AnnotationRow | null = null;
  if (body.parent_id !== undefined && body.parent_id !== null) {
    parent = await loadAnnotation(c.env.DB, ctx.text.id, typeof body.parent_id === "string" ? body.parent_id : undefined);
    parentId = parent.parent_id ?? parent.id;
  }
  const mentions = await mentionsOf(c.env.DB, ctx.project.id, body.mentions);
  const id = await create(c, ctx, { anchorType: parent?.anchor_type ?? body.anchor_type, anchorData: parent ? parent.anchor_data : anchorData, body: text, parentId, mentions });
  await afterWrite(c.env.DB, me, ctx.project.id, ctx.text.id, ctx.text.name, text, mentions, parentId);
  return c.json({ annotation: present(await loadAnnotation(c.env.DB, ctx.text.id, id), me) }, 201);
});

async function afterWrite(db: D1Database, me: string, projectId: string, textId: string, textName: string, text: string, mentions: string[], parentId: string | null) {
  const who = (await db.prepare("SELECT display_name FROM profiles WHERE subject = ?1").bind(me).first<{ display_name: string | null }>())?.display_name || "Someone";
  if (parentId) {
    // The thread's author hears of a reply only while still a member: the notification carries the text's name and the reply.
    const root = await db.prepare("SELECT a.author_subject FROM annotations a WHERE a.id = ?1 AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ?2 AND m.subject = a.author_subject)").bind(parentId, projectId).first<{ author_subject: string }>();
    if (root) await notify(db, [root.author_subject], me, { type: "comment_reply", title: `${who} replied to your comment on "${bodyPreview(textName, 80)}"`, body: text, link: linkFor(textId) });
  }
  if (mentions.length > 0) await notify(db, mentions, me, { type: "comment_mention", title: `${who} mentioned you on "${bodyPreview(textName, 80)}"`, body: text, link: linkFor(textId) });
}

annotationRoutes.get("/:id/annotations/:annotId", async (c) => {
  const me = c.get("principal").subject;
  const ctx = await requireTextRole(c.env.DB, me, idOf(c), "viewer");
  const a = await loadAnnotation(c.env.DB, ctx.text.id, c.req.param("annotId"));
  const replies = await c.env.DB.prepare(`${SELECT} WHERE a.parent_id = ?1 AND a.text_id = ?2 ORDER BY a.created_at, a.rowid LIMIT 500`).bind(a.id, ctx.text.id).all<AnnotationRow>();
  return c.json({ annotation: present(a, me), replies: replies.results.map((r) => present(r, me)) });
});

annotationRoutes.put("/:id/annotations/:annotId", async (c) => {
  const me = c.get("principal").subject;
  const ctx = await requireTextRole(c.env.DB, me, idOf(c), "viewer");
  const a = await loadAnnotation(c.env.DB, ctx.text.id, c.req.param("annotId"));
  if (a.author_subject !== me) throw E.forbidden("You can only edit your own annotations.", "not_author");
  const body = await readJsonObject(c.req.raw, 64 * 1024);
  const text = bodyOf(body.body);
  await c.env.DB.prepare("UPDATE annotations SET body = ?1, updated_at = ?2 WHERE id = ?3 AND author_subject = ?4").bind(text, nowIso(), a.id, me).run();
  return c.json({ annotation: present(await loadAnnotation(c.env.DB, ctx.text.id, a.id), me) });
});

for (const [action, resolved] of [["resolve", 1], ["unresolve", 0]] as const) {
  annotationRoutes.post(`/:id/annotations/:annotId/${action}`, async (c) => {
    const me = c.get("principal").subject;
    const ctx = await requireTextRole(c.env.DB, me, idOf(c), "editor");
    const a = await loadAnnotation(c.env.DB, ctx.text.id, c.req.param("annotId"));
    await c.env.DB.prepare("UPDATE annotations SET resolved = ?1, resolved_by = ?2, resolved_at = ?3, updated_at = ?4 WHERE id = ?5").bind(resolved, resolved ? me : null, resolved ? nowIso() : null, nowIso(), a.id).run();
    return c.json({ annotation: present(await loadAnnotation(c.env.DB, ctx.text.id, a.id), me) });
  });
}

annotationRoutes.delete("/:id/annotations/:annotId", async (c) => {
  const me = c.get("principal").subject;
  const ctx = await requireTextRole(c.env.DB, me, idOf(c), "viewer");
  const a = await loadAnnotation(c.env.DB, ctx.text.id, c.req.param("annotId"));
  if (a.author_subject !== me && ctx.role !== "owner") throw E.forbidden("You can only delete your own annotations.", "not_author");
  await c.env.DB.prepare("DELETE FROM annotations WHERE id = ?1 AND text_id = ?2").bind(a.id, ctx.text.id).run(); // replies cascade
  return c.json({ ok: true });
});

annotationRoutes.post("/:id/annotations/:annotId/replies", async (c) => {
  const me = c.get("principal").subject;
  const ctx = await requireTextRole(c.env.DB, me, idOf(c), "editor");
  const parent = await loadAnnotation(c.env.DB, ctx.text.id, c.req.param("annotId"));
  const body = await readJsonObject(c.req.raw, 64 * 1024);
  const text = bodyOf(body.body);
  const mentions = await mentionsOf(c.env.DB, ctx.project.id, body.mentions);
  const rootId = parent.parent_id ?? parent.id;
  const id = await create(c, ctx, { anchorType: parent.anchor_type, anchorData: parent.anchor_data, body: text, parentId: rootId, mentions });
  await afterWrite(c.env.DB, me, ctx.project.id, ctx.text.id, ctx.text.name, text, mentions, rootId);
  return c.json({ annotation: present(await loadAnnotation(c.env.DB, ctx.text.id, id), me) }, 201);
});
