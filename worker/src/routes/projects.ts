import { Hono } from "hono";
import { requireRole } from "../authz";
import { optionalString, readJsonObject, requiredString } from "../body";
import { limits } from "../env";
import { E } from "../errors";
import { deleteProject } from "../storage";
import { notify } from "../notify";
import { addDays, isSubject, newId, nowIso } from "../util";
import { projectInviteRoutes as inviteRoutes } from "./project-invites";
import { projectTextRoutes } from "./project-texts";
import { exportRoutes } from "./export";
import type { AppEnv } from "../app";
import type { ProjectRow, Role } from "../authz";

export const projectRoutes = new Hono<AppEnv>();

const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

function projectBody(p: ProjectRow, role: Role, lim: ReturnType<typeof limits>, now: string) {
  const deleteAfter = addDays(p.last_edited_at, lim.retentionDays);
  const warnFrom = addDays(deleteAfter, -lim.retentionWarnDays);
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    project_type: p.project_type,
    default_language: p.default_language,
    owner_subject: p.owner_subject,
    role,
    created_at: p.created_at,
    updated_at: p.updated_at,
    last_edited_at: p.last_edited_at,
    // Shown in-app so nobody is surprised: the project is deleted at delete_after
    // unless edited first; `warning` is true once inside the warning window.
    retention: { delete_after: deleteAfter, warning: now >= warnFrom, days_remaining: Math.max(0, Math.ceil((Date.parse(deleteAfter) - Date.parse(now)) / 86_400_000)) },
  };
}

projectRoutes.get("/", async (c) => {
  const { subject } = c.get("principal");
  const lim = limits(c.env);
  const now = nowIso();
  const rows = await c.env.DB.prepare(
    `SELECT p.*, m.role AS member_role FROM project_members m JOIN projects p ON p.id = m.project_id
     WHERE m.subject = ?1 ORDER BY p.updated_at DESC LIMIT 200`,
  )
    .bind(subject)
    .all<ProjectRow & { member_role: Role }>();
  return c.json({ projects: rows.results.map(({ member_role, ...p }) => projectBody(p, member_role, lim, now)) });
});

projectRoutes.post("/", async (c) => {
  const { subject } = c.get("principal");
  const lim = limits(c.env);
  const body = await readJsonObject(c.req.raw, lim.maxJsonBytes);
  const name = requiredString(body, "name", 200);
  const description = optionalString(body, "description", 2000) ?? null;
  const type = optionalString(body, "project_type", 20) ?? "image_to_markdown";
  if (type !== "image_to_markdown" && type !== "pdf_to_html") throw E.badRequest("project_type must be image_to_markdown or pdf_to_html.");
  const language = optionalString(body, "default_language", 20) ?? "en";
  if (!LANG.test(language)) throw E.badRequest("default_language must be a language code such as en or pt-BR.");

  const id = newId();
  const now = nowIso();
  // Both statements in one transaction. The project insert is conditional on the
  // per-person cap, and the owner row only exists if its project does.
  const [created] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO projects (id, owner_subject, name, description, project_type, default_language, created_at, updated_at, last_edited_at)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?7,?7 WHERE (SELECT COUNT(*) FROM projects WHERE owner_subject = ?2) < ?8`,
    ).bind(id, subject, name, description, type, language, now, lim.maxProjectsPerPerson),
    c.env.DB.prepare("INSERT INTO project_members (project_id, subject, role, created_at) SELECT ?1, ?2, 'owner', ?3 WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1)").bind(id, subject, now),
  ]);
  if (created?.meta.changes !== 1) throw E.conflict(`You can own at most ${lim.maxProjectsPerPerson} projects.`, "project_limit_reached");
  const { project, role } = await requireRole(c.env.DB, subject, id, "owner");
  return c.json({ project: projectBody(project, role, lim, now) }, 201);
});

projectRoutes.get("/:id", async (c) => {
  const { subject } = c.get("principal");
  const { project, role } = await requireRole(c.env.DB, subject, c.req.param("id"), "viewer");
  const counts = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM texts WHERE project_id = ?1) AS texts, (SELECT COUNT(*) FROM project_members WHERE project_id = ?1) AS members",
  )
    .bind(project.id)
    .first<{ texts: number; members: number }>();
  return c.json({ project: { ...projectBody(project, role, limits(c.env), nowIso()), text_count: counts?.texts ?? 0, member_count: counts?.members ?? 0 } });
});

projectRoutes.put("/:id", async (c) => {
  const { subject } = c.get("principal");
  const lim = limits(c.env);
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id"), "owner");
  const body = await readJsonObject(c.req.raw, lim.maxJsonBytes);
  const name = optionalString(body, "name", 200);
  if (name === "") throw E.badRequest("name cannot be empty.");
  const description = body.description === null ? null : optionalString(body, "description", 2000);
  const language = optionalString(body, "default_language", 20);
  if (language !== undefined && !LANG.test(language)) throw E.badRequest("default_language must be a language code such as en or pt-BR.");
  const now = nowIso();
  await c.env.DB.prepare(
    `UPDATE projects SET name = COALESCE(?1, name),
       description = CASE WHEN ?2 THEN ?3 ELSE description END,
       default_language = COALESCE(?4, default_language),
       updated_at = ?5, last_edited_at = ?5, retention_warned_at = NULL
     WHERE id = ?6`,
  )
    .bind(name ?? null, description === undefined ? 0 : 1, description ?? null, language ?? null, now, project.id)
    .run();
  const updated = await requireRole(c.env.DB, subject, project.id, "owner");
  return c.json({ project: projectBody(updated.project, updated.role, lim, now) });
});

projectRoutes.delete("/:id", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id"), "owner");
  await deleteProject(c.env, project.id);
  return c.json({ deleted: true });
});

// ---- membership -----------------------------------------------------------

projectRoutes.get("/:id/members", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id"), "viewer");
  const rows = await c.env.DB.prepare(
    `SELECT m.subject, m.role, m.created_at, p.display_name
     FROM project_members m JOIN profiles p ON p.subject = m.subject
     WHERE m.project_id = ?1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.created_at`,
  )
    .bind(project.id)
    .all<{ subject: string; role: Role; created_at: string; display_name: string | null }>();
  return c.json({ members: rows.results.map((m) => ({ ...m, me: m.subject === subject })) });
});

// Owners remove members; anyone except the owner may remove themselves (leave).
projectRoutes.delete("/:id/members/:subject", async (c) => {
  const { subject } = c.get("principal");
  const target = c.req.param("subject");
  if (!isSubject(target)) throw E.notFound("Member not found.");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id"), target === subject ? "viewer" : "owner");
  if (target === project.owner_subject) throw E.conflict("The owner cannot be removed. Delete the project instead.", "owner_cannot_leave");
  const res = await c.env.DB.prepare("DELETE FROM project_members WHERE project_id = ?1 AND subject = ?2 AND role != 'owner'").bind(project.id, target).run();
  if (res.meta.changes !== 1) throw E.notFound("Member not found.");
  return c.json({ removed: true });
});

// Owners change a member between editor and viewer. The owner's own role only
// changes through a transfer.
projectRoutes.put("/:id/members/:subject", async (c) => {
  const { subject } = c.get("principal");
  const target = c.req.param("subject");
  if (!isSubject(target)) throw E.notFound("Member not found.");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id"), "owner");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  if (body.role !== "editor" && body.role !== "viewer") throw E.badRequest("role must be editor or viewer.");
  if (target === project.owner_subject) throw E.conflict("The owner's role changes only by transferring ownership.", "owner_role_fixed");
  const res = await c.env.DB.prepare("UPDATE project_members SET role = ?3 WHERE project_id = ?1 AND subject = ?2 AND role != 'owner'").bind(project.id, target, body.role).run();
  if (res.meta.changes !== 1) throw E.notFound("Member not found.");
  return c.json({ member: { subject: target, role: body.role } });
});

// ---- ownership transfer: offered by the owner, accepted by the member --------
// The owner offers the project to one member; nothing moves until that member
// accepts with their own request (src/routes/transfers.ts). The old owner stays
// on as an editor and may leave afterwards. One pending offer per project.

export const TRANSFER_OFFER_DAYS = 7;

projectRoutes.get("/:id/transfer", async (c) => {
  const { project } = await requireRole(c.env.DB, c.get("principal").subject, c.req.param("id"), "owner");
  const offer = await c.env.DB.prepare(
    `SELECT o.id, o.to_subject, p.display_name AS to_name, o.created_at, o.expires_at FROM transfer_offers o JOIN profiles p ON p.subject = o.to_subject
     WHERE o.project_id = ?1 AND o.expires_at > ?2`,
  ).bind(project.id, nowIso()).first();
  return c.json({ offer: offer ?? null });
});

projectRoutes.post("/:id/transfer", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id"), "owner");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const target = body.subject;
  if (typeof target !== "string" || !isSubject(target)) throw E.badRequest("subject must name a member.");
  if (target === project.owner_subject) throw E.conflict("You already own this project.", "already_owner");
  const now = nowIso();
  const id = newId();
  const expiresAt = addDays(now, TRANSFER_OFFER_DAYS);
  // An expired offer gives way; a live one must be revoked first. The member check is in the insert.
  const [, inserted] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM transfer_offers WHERE project_id = ?1 AND expires_at <= ?2 AND claim_nonce IS NULL").bind(project.id, now),
    c.env.DB.prepare(
      `INSERT INTO transfer_offers (id, project_id, from_subject, to_subject, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE EXISTS (SELECT 1 FROM project_members WHERE project_id = ?2 AND subject = ?4 AND role != 'owner')
         AND NOT EXISTS (SELECT 1 FROM transfer_offers WHERE project_id = ?2)`,
    ).bind(id, project.id, subject, target, now, expiresAt),
  ]);
  if (inserted?.meta.changes !== 1) {
    const live = await c.env.DB.prepare("SELECT 1 AS x FROM transfer_offers WHERE project_id = ?1").bind(project.id).first();
    if (live) throw E.conflict("This project already has a pending transfer offer. Revoke it first.", "transfer_pending");
    throw E.notFound("Member not found.");
  }
  const who = await c.env.DB.prepare("SELECT display_name FROM profiles WHERE subject = ?1").bind(subject).first<{ display_name: string | null }>();
  await notify(c.env.DB, [target], subject, { type: "project_shared", title: `${who?.display_name || "Someone"} offered you ownership of "${project.name.slice(0, 80)}"`, link: `/projects/${project.id}` });
  return c.json({ offer: { id, to_subject: target, created_at: now, expires_at: expiresAt } }, 201);
});

projectRoutes.delete("/:id/transfer", async (c) => {
  const { project } = await requireRole(c.env.DB, c.get("principal").subject, c.req.param("id"), "owner");
  const res = await c.env.DB.prepare("DELETE FROM transfer_offers WHERE project_id = ?1 AND claim_nonce IS NULL").bind(project.id).run();
  if (res.meta.changes !== 1) throw E.notFound("No pending transfer offer.");
  return c.json({ revoked: true });
});

projectRoutes.route("/:id/invites", inviteRoutes);
projectRoutes.route("/:id/texts", projectTextRoutes);
projectRoutes.route("/", exportRoutes);
