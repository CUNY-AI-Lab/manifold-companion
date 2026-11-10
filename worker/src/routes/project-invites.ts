import { Hono } from "hono";
import { requireRole } from "../authz";
import { readJsonObject } from "../body";
import { limits } from "../env";
import { E } from "../errors";
import { addDays, isUuid, newId, nowIso, randomToken, sha256Hex } from "../util";
import { BASE_PATH, canonicalOrigin } from "../env";
import type { AppEnv } from "../app";

/** Owner-only invite management, mounted at /projects/:id/invites. */
export const projectInviteRoutes = new Hono<AppEnv>();

projectInviteRoutes.post("/", async (c) => {
  const { subject } = c.get("principal");
  const lim = limits(c.env);
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "owner");
  const body = await readJsonObject(c.req.raw, lim.maxJsonBytes);
  const role = body.role;
  if (role !== "editor" && role !== "viewer") throw E.badRequest("role must be editor or viewer.");
  const days = body.expires_in_days === undefined ? 7 : body.expires_in_days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > lim.maxInviteTtlDays) {
    throw E.badRequest(`expires_in_days must be an integer from 1 to ${lim.maxInviteTtlDays}.`);
  }
  const now = nowIso();
  const token = randomToken();
  const id = newId();
  const expiresAt = addDays(now, days);
  // Conditional insert: the active-invite cap is checked inside the statement.
  const res = await c.env.DB.prepare(
    `INSERT INTO invites (id, project_id, token_hash, role, created_by, created_at, expires_at)
     SELECT ?1,?2,?3,?4,?5,?6,?7
     WHERE (SELECT COUNT(*) FROM invites WHERE project_id = ?2 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?6) < ?8`,
  ).bind(id, project.id, await sha256Hex(token), role, subject, now, expiresAt, lim.maxActiveInvitesPerProject).run();
  if (res.meta.changes !== 1) throw E.conflict("Too many active invite links. Revoke some first.", "invite_limit_reached");
  // The token goes in the URL fragment so it never reaches a server log or a Referer.
  return c.json({ invite: { id, role, created_at: now, expires_at: expiresAt, token, url: `${canonicalOrigin(c.env)}${BASE_PATH}/invite#t=${token}` } }, 201);
});

projectInviteRoutes.get("/", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "owner");
  const now = nowIso();
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.role, i.created_at, i.expires_at, i.revoked_at, i.redeemed_at, i.redeemed_by, p.display_name AS redeemed_by_name
     FROM invites i LEFT JOIN profiles p ON p.subject = i.redeemed_by
     WHERE i.project_id = ?1 ORDER BY i.created_at DESC LIMIT 100`,
  )
    .bind(project.id)
    .all<{ id: string; role: string; created_at: string; expires_at: string; revoked_at: string | null; redeemed_at: string | null; redeemed_by: string | null; redeemed_by_name: string | null }>();
  return c.json({
    invites: rows.results.map((r) => ({
      ...r,
      status: r.redeemed_at ? "redeemed" : r.revoked_at ? "revoked" : r.expires_at <= now ? "expired" : "active",
    })),
  });
});

projectInviteRoutes.delete("/:inviteId", async (c) => {
  const { subject } = c.get("principal");
  const { project } = await requireRole(c.env.DB, subject, c.req.param("id") as string, "owner");
  const inviteId = c.req.param("inviteId");
  if (!isUuid(inviteId)) throw E.notFound("Invite not found.");
  const row = await c.env.DB.prepare("SELECT redeemed_at, revoked_at FROM invites WHERE id = ?1 AND project_id = ?2").bind(inviteId, project.id).first<{ redeemed_at: string | null; revoked_at: string | null }>();
  if (!row) throw E.notFound("Invite not found.");
  if (row.redeemed_at) throw E.conflict("This invite was already used. Remove the member instead.", "invite_already_redeemed");
  if (!row.revoked_at) {
    await c.env.DB.prepare("UPDATE invites SET revoked_at = ?1 WHERE id = ?2 AND redeemed_at IS NULL").bind(nowIso(), inviteId).run();
  }
  return c.json({ revoked: true });
});
