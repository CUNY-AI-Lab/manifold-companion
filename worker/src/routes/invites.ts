import { Hono } from "hono";
import { readJsonObject } from "../body";
import { E } from "../errors";
import { TOKEN_PATTERN, nowIso, sha256Hex } from "../util";
import { notify } from "../notify";
import type { AppEnv } from "../app";

/** Redemption: the one invite route that is not project-scoped (the redeemer has no role yet). */
export const inviteRoutes = new Hono<AppEnv>();

interface InviteRow {
  id: string;
  project_id: string;
  role: "editor" | "viewer";
  expires_at: string;
  revoked_at: string | null;
  redeemed_by: string | null;
  redeemed_at: string | null;
}

inviteRoutes.post("/redeem", async (c) => {
  const { subject } = c.get("principal");
  const body = await readJsonObject(c.req.raw, 2048);
  const token = body.token;
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw E.notFound("This invite link is not valid.");
  const invite = await c.env.DB.prepare("SELECT id, project_id, role, expires_at, revoked_at, redeemed_by, redeemed_at FROM invites WHERE token_hash = ?1")
    .bind(await sha256Hex(token))
    .first<InviteRow>();
  if (!invite) throw E.notFound("This invite link is not valid.");

  // Retrying your own redemption is harmless: you are already bound.
  if (invite.redeemed_at) {
    if (invite.redeemed_by === subject) return c.json({ project_id: invite.project_id, role: invite.role, already_redeemed: true });
    throw E.gone("This invite link has already been used.", "invite_used");
  }
  if (invite.revoked_at) throw E.gone("This invite link was revoked.", "invite_revoked");
  const now = nowIso();
  if (invite.expires_at <= now) throw E.gone("This invite link has expired.", "invite_expired");

  const existing = await c.env.DB.prepare("SELECT role FROM project_members WHERE project_id = ?1 AND subject = ?2").bind(invite.project_id, subject).first<{ role: string }>();
  if (existing) throw E.conflict("You already have access to this project.", "already_member");

  // Atomic: the UPDATE claims the invite only if it is still unredeemed, unrevoked
  // and unexpired; the INSERT runs in the same transaction and only if THIS
  // subject now holds the claim. Two racing redeemers cannot both win.
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE invites SET redeemed_by = ?1, redeemed_at = ?2 WHERE id = ?3 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?2",
    ).bind(subject, now, invite.id),
    c.env.DB.prepare(
      `INSERT INTO project_members (project_id, subject, role, created_at)
       SELECT project_id, ?1, role, ?2 FROM invites WHERE id = ?3 AND redeemed_by = ?1 AND redeemed_at = ?2`,
    ).bind(subject, now, invite.id),
    ]);
  } catch (error) {
    // The same person redeeming two links to one project at once: the second membership
    // insert hits the primary key and the whole batch (including the claim) rolls back.
    if (error instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(error.message)) throw E.conflict("You already have access to this project.", "already_member");
    throw error;
  }
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) throw E.gone("This invite link has already been used.", "invite_used");
  const info = await c.env.DB.prepare("SELECT p.owner_subject, p.name, (SELECT display_name FROM profiles WHERE subject = ?2) AS who FROM projects p WHERE p.id = ?1").bind(invite.project_id, subject).first<{ owner_subject: string; name: string; who: string | null }>();
  if (info) await notify(c.env.DB, [info.owner_subject], subject, { type: "project_shared", title: `${info.who || "Someone"} joined "${info.name.slice(0, 80)}" as ${invite.role}`, link: `/projects/${invite.project_id}` });
  return c.json({ project_id: invite.project_id, role: invite.role, already_redeemed: false }, 201);
});
