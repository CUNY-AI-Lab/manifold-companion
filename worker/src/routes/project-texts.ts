// Text collection routes, mounted at /projects/:id/texts.
import { Hono } from "hono";
import { requireRole } from "../authz";
import { optionalString, readJsonObject, requiredString } from "../body";
import { CAPS, reindexText, touchProject } from "../content";
import { limits } from "../env";
import { E } from "../errors";
import { deleteTextObjects, mergeTexts } from "../text-ops";
import { newId, nowIso, isUuid } from "../util";
import type { AppEnv } from "../app";

export const projectTextRoutes = new Hono<AppEnv>();

const STATUSES = new Set(["pending", "ocrd", "reviewed"]);
const MAX_BULK = 50;

function uuidList(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw E.badRequest(`${label} must be a non-empty array.`);
  if (value.length > max) throw E.badRequest(`${label} can hold at most ${max} items.`);
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !isUuid(v)) throw E.badRequest(`${label} must contain valid ids.`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

const listColumns = `t.id, t.name, t.status, t.sort_order, t.source_pdf_name, t.created_at, t.updated_at,
  (t.html_key IS NOT NULL) AS has_html, (t.source_pdf_key IS NOT NULL) AS has_source_pdf,
  (SELECT COUNT(*) FROM pages pg WHERE pg.text_id = t.id) AS page_count`;

projectTextRoutes.get("/", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "viewer");
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const rows = await c.env.DB.prepare(`SELECT ${listColumns} FROM texts t WHERE t.project_id = ?1 ORDER BY t.sort_order, t.created_at, t.rowid LIMIT ?2 OFFSET ?3`)
    .bind(project.id, limit, (page - 1) * limit)
    .all();
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM texts WHERE project_id = ?1").bind(project.id).first<{ n: number }>();
  return c.json({ texts: rows.results, page, limit, total: total?.n ?? 0 });
});

projectTextRoutes.post("/", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const name = requiredString(body, "name", 200);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), 0) AS m FROM texts WHERE project_id = ?1").bind(project.id).first<{ n: number; m: number }>();
  if ((count?.n ?? 0) >= CAPS.maxTextsPerProject) throw E.conflict(`A project can hold at most ${CAPS.maxTextsPerProject} texts.`, "text_limit_reached");
  const id = newId();
  const now = nowIso();
  await c.env.DB.prepare("INSERT INTO texts (id, project_id, name, sort_order, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)").bind(id, project.id, name, (count?.m ?? 0) + 1, now).run();
  await touchProject(c.env.DB, project.id, now);
  await reindexText(c.env, id);
  const row = await c.env.DB.prepare(`SELECT ${listColumns} FROM texts t WHERE t.id = ?1`).bind(id).first();
  return c.json({ text: row }, 201);
});

projectTextRoutes.put("/reorder", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const ids = uuidList(body.textIds, CAPS.maxTextsPerProject, "textIds");
  const own = await c.env.DB.prepare("SELECT id FROM texts WHERE project_id = ?1").bind(project.id).all<{ id: string }>();
  const have = new Set(own.results.map((r) => r.id));
  if (ids.some((id) => !have.has(id))) throw E.badRequest("textIds must all belong to this project.");
  await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare("UPDATE texts SET sort_order = ?1 WHERE id = ?2 AND project_id = ?3").bind(i + 1, id, project.id)));
  await touchProject(c.env.DB, project.id);
  return c.json({ ok: true });
});

projectTextRoutes.post("/bulk-status", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const ids = uuidList(body.textIds, MAX_BULK, "textIds");
  if (typeof body.status !== "string" || !STATUSES.has(body.status)) throw E.badRequest("status must be one of: pending, ocrd, reviewed.");
  const res = await c.env.DB.prepare(`UPDATE texts SET status = ?1, updated_at = ?2 WHERE project_id = ?3 AND id IN (${ids.map((_, i) => `?${i + 4}`).join(",")})`)
    .bind(body.status, nowIso(), project.id, ...ids)
    .run();
  await touchProject(c.env.DB, project.id);
  return c.json({ updated: res.meta.changes });
});

projectTextRoutes.post("/bulk-delete", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const ids = uuidList(body.textIds, MAX_BULK, "textIds");
  let deleted = 0;
  for (const id of ids) if (await deleteTextObjects(c.env, project, id)) deleted += 1;
  await touchProject(c.env.DB, project.id);
  return c.json({ deleted });
});

projectTextRoutes.post("/merge", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "editor");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const ids = uuidList(body.textIds, 50, "textIds");
  if (ids.length < 2) throw E.badRequest("At least 2 texts are required to merge.");
  const name = requiredString(body, "name", 200);
  const found = await c.env.DB.prepare(`SELECT id FROM texts WHERE project_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(",")})`).bind(project.id, ...ids).all<{ id: string }>();
  if (found.results.length !== ids.length) throw E.badRequest("Every text must belong to this project.");
  const merged = await mergeTexts(c.env, project, ids, name);
  return c.json({ text: merged }, 201);
});
