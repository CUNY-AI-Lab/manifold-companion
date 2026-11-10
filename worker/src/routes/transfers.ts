// Ownership transfer offers, seen and answered by the member they are made to.
// Mounted at /transfers. The owner's side is in routes/projects.ts.
import { Hono } from "hono";
import { E } from "../errors";
import { limits } from "../env";
import { notify } from "../notify";
import { projectBytesSql, projectReservedSql } from "../storage";
import { isUuid, newId, nowIso } from "../util";
import type { AppEnv } from "../app";

export const transferRoutes = new Hono<AppEnv>();

interface OfferRow { id: string; project_id: string; from_subject: string; to_subject: string; expires_at: string; project_name: string }

/** The live offers made to me. */
transferRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT o.id, o.project_id, pr.name AS project_name, p.display_name AS from_name, o.created_at, o.expires_at
     FROM transfer_offers o JOIN projects pr ON pr.id = o.project_id JOIN profiles p ON p.subject = o.from_subject
     WHERE o.to_subject = ?1 AND o.expires_at > ?2
       AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = o.project_id AND m.subject = o.to_subject)
     ORDER BY o.created_at DESC LIMIT 50`,
  ).bind(c.get("principal").subject, nowIso()).all();
  return c.json({ offers: rows.results });
});

/** Only the member the offer names, while still a member, can see or answer it; to anyone else it does not exist. */
async function myOffer(db: D1Database, offerId: string, subject: string): Promise<OfferRow> {
  if (!isUuid(offerId)) throw E.notFound("Transfer offer not found.");
  const row = await db.prepare(
    "SELECT o.id, o.project_id, o.from_subject, o.to_subject, o.expires_at, pr.name AS project_name FROM transfer_offers o JOIN projects pr ON pr.id = o.project_id WHERE o.id = ?1 AND o.to_subject = ?2 AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = o.project_id AND m.subject = ?2)",
  ).bind(offerId, subject).first<OfferRow>();
  if (!row) throw E.notFound("Transfer offer not found.");
  if (row.expires_at <= nowIso()) throw E.gone("This transfer offer has expired. Ask the owner for a new one.", "transfer_expired");
  return row;
}

transferRoutes.post("/:offerId/decline", async (c) => {
  const subject = c.get("principal").subject;
  const offer = await myOffer(c.env.DB, c.req.param("offerId"), subject);
  await c.env.DB.prepare("DELETE FROM transfer_offers WHERE id = ?1 AND to_subject = ?2").bind(offer.id, subject).run();
  return c.json({ declined: true });
});

/**
 * Accept: ONE D1 batch (one transaction: all of it happens or none of it, and
 * no other request sees the middle). Every statement after the first depends on
 * THIS request's nonce, so a repeated or concurrent accept (or one racing a
 * revoke) can never satisfy them:
 *   1. claim the offer (only if still unclaimed, unexpired and addressed to me),
 *      recording the nonce and the project's bytes measured right now: what
 *      its rows account for plus what is reserved for its uploads in flight;
 *   2. move the project's owner, only if the claim with this nonce exists, the
 *      offerer still owns it, I am still a member, the bytes fit in my storage
 *      and I am under the project limit; stamp the project with the nonce;
 *   3-7. credit me and debit the previous owner by the claimed bytes, move the
 *      project's reservations to me (so an upload in flight commits or
 *      releases on my counter), swap the two membership roles, each only
 *      where the project carries this nonce;
 *   8. delete the claimed offer if the move happened;
 *   9. otherwise release the claim, in the same batch.
 * So a claim never outlives the transaction that took it: an interrupted
 * Worker leaves no stuck claim (the whole batch commits or rolls back). As a
 * backstop, every other path (list, decline, revoke, a new offer, a later
 * accept) treats a claim it can see as absent, since a visible claim can only
 * be a leftover. */
transferRoutes.post("/:offerId/accept", async (c) => {
  const subject = c.get("principal").subject;
  const lim = limits(c.env);
  const offer = await myOffer(c.env.DB, c.req.param("offerId"), subject);
  const nonce = newId();
  const now = nowIso();
  const db = c.env.DB;
  const projectStamped = "(SELECT transfer_nonce FROM projects WHERE id = ?2) = ?1";
  const claimedBytes = "(SELECT claim_bytes FROM transfer_offers WHERE claim_nonce = ?1)";
  const results = await db.batch([
    db.prepare(`UPDATE transfer_offers SET claim_nonce = ?1, claim_bytes = ${projectBytesSql("?2")} + ${projectReservedSql("?2")}
                WHERE id = ?3 AND project_id = ?2 AND to_subject = ?4 AND expires_at > ?5`).bind(nonce, offer.project_id, offer.id, subject, now),
    db.prepare(`UPDATE projects SET owner_subject = ?4, transfer_nonce = ?1, updated_at = ?7
                WHERE id = ?2 AND owner_subject = ?3
                  AND EXISTS (SELECT 1 FROM transfer_offers WHERE claim_nonce = ?1 AND project_id = ?2 AND from_subject = ?3 AND to_subject = ?4)
                  AND EXISTS (SELECT 1 FROM project_members WHERE project_id = ?2 AND subject = ?4 AND role != 'owner')
                  AND (SELECT storage_bytes FROM profiles WHERE subject = ?4) + ${claimedBytes} <= ?5
                  AND (SELECT COUNT(*) FROM projects WHERE owner_subject = ?4) < ?6`).bind(nonce, offer.project_id, offer.from_subject, subject, lim.storageQuotaBytes, lim.maxProjectsPerPerson, now),
    db.prepare(`UPDATE profiles SET storage_bytes = storage_bytes + ${claimedBytes} WHERE subject = ?3 AND ${projectStamped}`).bind(nonce, offer.project_id, subject),
    db.prepare(`UPDATE profiles SET storage_bytes = MAX(0, storage_bytes - ${claimedBytes}) WHERE subject = ?3 AND ${projectStamped}`).bind(nonce, offer.project_id, offer.from_subject),
    db.prepare(`UPDATE storage_reservations SET subject = ?4 WHERE project_id = ?2 AND subject = ?3 AND ${projectStamped}`).bind(nonce, offer.project_id, offer.from_subject, subject),
    db.prepare(`UPDATE project_members SET role = 'editor' WHERE project_id = ?2 AND subject = ?3 AND role = 'owner' AND ${projectStamped}`).bind(nonce, offer.project_id, offer.from_subject),
    db.prepare(`UPDATE project_members SET role = 'owner' WHERE project_id = ?2 AND subject = ?3 AND ${projectStamped}`).bind(nonce, offer.project_id, subject),
    db.prepare(`DELETE FROM transfer_offers WHERE claim_nonce = ?1 AND ${projectStamped}`).bind(nonce, offer.project_id),
    db.prepare(`UPDATE transfer_offers SET claim_nonce = NULL, claim_bytes = NULL WHERE claim_nonce = ?1 AND (SELECT transfer_nonce FROM projects WHERE id = ?2) IS NOT ?1`).bind(nonce, offer.project_id),
  ]);
  const [claim, moved] = results;
  if (moved?.meta.changes !== 1) {
    // The batch already released this request's claim; the offer can still be answered.
    if (claim?.meta.changes !== 1) throw E.conflict("This transfer offer was already answered or revoked.", "transfer_conflict");
    const room = await db.prepare(`SELECT (SELECT storage_bytes FROM profiles WHERE subject = ?2) + ${projectBytesSql("?1")} + ${projectReservedSql("?1")} <= ?3 AS fits, (SELECT COUNT(*) FROM projects WHERE owner_subject = ?2) < ?4 AS under`).bind(offer.project_id, subject, lim.storageQuotaBytes, lim.maxProjectsPerPerson).first<{ fits: number; under: number }>();
    if (room && !room.fits) throw E.conflict("You do not have enough storage left to take over this project. Free some space, or ask the owner to remove files first.", "transfer_quota_exceeded");
    if (room && !room.under) throw E.conflict("You already own as many projects as allowed.", "transfer_project_limit");
    throw E.conflict("The project changed while transferring (the owner or your membership changed). Ask the owner for a new offer.", "transfer_conflict");
  }
  const who = await db.prepare("SELECT display_name FROM profiles WHERE subject = ?1").bind(subject).first<{ display_name: string | null }>();
  await notify(db, [offer.from_subject], subject, { type: "project_shared", title: `${who?.display_name || "Someone"} accepted ownership of "${offer.project_name.slice(0, 80)}"; you are now an editor`, link: `/projects/${offer.project_id}` });
  return c.json({ project_id: offer.project_id, owner: subject, previous_owner_role: "editor" });
});
