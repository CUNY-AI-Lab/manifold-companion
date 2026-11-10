import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, api, call, createProject, invite, json, redeem } from "./helpers";
import { canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";
import { sha256Hex } from "../src/util";

const DAVE = canonicalTestSubject("dave");

describe("invite lifecycle", () => {
  it("creates a link whose token is shown once, stored only as a hash, and carried in the fragment", async () => {
    const id = await createProject(ALICE);
    const res = await call(api(`/projects/${id}/invites`), { method: "POST", body: { role: "editor", expires_in_days: 3 } });
    expect(res.status).toBe(201);
    const { invite: inv } = await json(res);
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inv.url).toBe(`https://tools.ailab.gc.cuny.edu/manifold-companion/invite#t=${inv.token}`);
    const row = await env.DB.prepare("SELECT token_hash FROM invites WHERE id = ?").bind(inv.id).first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256Hex(inv.token));
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM invites").all())).not.toContain(inv.token);
    const list = await json(await call(api(`/projects/${id}/invites`)));
    expect(JSON.stringify(list)).not.toContain(inv.token);
    expect(list.invites[0]).toMatchObject({ id: inv.id, role: "editor", status: "active" });
    const ttlDays = (Date.parse(inv.expires_at) - Date.parse(inv.created_at)) / 86_400_000;
    expect(ttlDays).toBe(3);
  });

  it("redeeming binds the invite's role to the redeemer's subject", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "editor");
    const res = await redeem(BOB, inv.token);
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ project_id: id, role: "editor", already_redeemed: false });
    const members = (await json(await call(api(`/projects/${id}/members`), { as: ALICE }))).members;
    expect(members.find((m: any) => m.subject === BOB).role).toBe("editor");
    const list = (await json(await call(api(`/projects/${id}/invites`)))).invites;
    expect(list[0]).toMatchObject({ status: "redeemed", redeemed_by: BOB });
  });

  it("a viewer invite cannot be used to become an editor", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "viewer");
    await redeem(BOB, inv.token);
    expect((await call(api(`/projects/${id}`), { method: "PUT", as: BOB, body: { name: "x" } })).status).toBe(403);
    const row = await env.DB.prepare("SELECT role FROM project_members WHERE project_id = ? AND subject = ?").bind(id, BOB).first<{ role: string }>();
    expect(row!.role).toBe("viewer");
  });

  it("is single use: a second person is refused, the first may retry harmlessly", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "viewer");
    expect((await redeem(BOB, inv.token)).status).toBe(201);
    const second = await redeem(CAROL, inv.token);
    expect(second.status).toBe(410);
    expect((await json(second)).error.code).toBe("invite_used");
    expect((await call(api(`/projects/${id}`), { as: CAROL })).status).toBe(404);
    const retry = await redeem(BOB, inv.token);
    expect(retry.status).toBe(200);
    expect(await json(retry)).toMatchObject({ already_redeemed: true });
  });

  it("racing redeemers: exactly one wins", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "viewer");
    const results = await Promise.all([redeem(BOB, inv.token), redeem(CAROL, inv.token), redeem(DAVE, inv.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410, 410]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?").bind(id).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it("expired invites are refused and expire server-side", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "viewer");
    await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").bind("2020-01-01T00:00:00Z", inv.id).run();
    const res = await redeem(BOB, inv.token);
    expect(res.status).toBe(410);
    expect((await json(res)).error.code).toBe("invite_expired");
    expect((await json(await call(api(`/projects/${id}/invites`)))).invites[0].status).toBe("expired");
  });

  it("revoked invites are refused, revoking is idempotent, and a used invite cannot be revoked", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "viewer");
    expect((await call(api(`/projects/${id}/invites/${inv.id}`), { method: "DELETE" })).status).toBe(200);
    expect((await call(api(`/projects/${id}/invites/${inv.id}`), { method: "DELETE" })).status).toBe(200);
    const res = await redeem(BOB, inv.token);
    expect(res.status).toBe(410);
    expect((await json(res)).error.code).toBe("invite_revoked");

    const used = await invite(ALICE, id, "viewer");
    await redeem(BOB, used.token);
    const revoke = await call(api(`/projects/${id}/invites/${used.id}`), { method: "DELETE" });
    expect(revoke.status).toBe(409);
    expect((await json(revoke)).error.code).toBe("invite_already_redeemed");
    expect((await call(api(`/projects/${id}/invites/00000000-0000-4000-8000-000000000000`), { method: "DELETE" })).status).toBe(404);
  });

  it("an invite for one project cannot be revoked through another project's URL", async () => {
    const a = await createProject(ALICE);
    const b = await createProject(BOB);
    const inv = await invite(ALICE, a, "viewer");
    expect((await call(api(`/projects/${b}/invites/${inv.id}`), { method: "DELETE", as: BOB })).status).toBe(404);
    expect((await redeem(CAROL, inv.token)).status).toBe(201);
  });

  it("guessing: malformed, unknown and truncated tokens are 404 and reveal nothing", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "viewer");
    for (const token of ["", "short", "A".repeat(43), inv.token.slice(0, 42), inv.token + "x", 5, null]) {
      const res = await call(api("/invites/redeem"), { method: "POST", as: BOB, body: { token } });
      expect(res.status, String(token)).toBe(404);
    }
    expect((await call(api("/invites/redeem"), { method: "POST", as: BOB, body: {} })).status).toBe(404);
  });

  it("existing members are not re-added and the invite is not consumed", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "editor");
    const res = await redeem(ALICE, inv.token);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("already_member");
    expect((await redeem(BOB, inv.token)).status).toBe(201);
  });

  it("validates role and lifetime, and caps active invites", async () => {
    const id = await createProject(ALICE);
    for (const body of [{}, { role: "owner" }, { role: "admin" }, { role: "viewer", expires_in_days: 0 }, { role: "viewer", expires_in_days: 31 }, { role: "viewer", expires_in_days: 1.5 }]) {
      expect((await call(api(`/projects/${id}/invites`), { method: "POST", body })).status, JSON.stringify(body)).toBe(400);
    }
    for (let i = 0; i < 20; i += 1) await invite(ALICE, id, "viewer");
    const over = await call(api(`/projects/${id}/invites`), { method: "POST", body: { role: "viewer" } });
    expect(over.status).toBe(409);
    expect((await json(over)).error.code).toBe("invite_limit_reached");
  });

  it("deleting the project removes its invites; the token then goes nowhere", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "viewer");
    await call(api(`/projects/${id}`), { method: "DELETE" });
    expect((await redeem(BOB, inv.token)).status).toBe(404);
  });
});
