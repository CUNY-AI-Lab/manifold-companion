// Member role change and ownership transfer.
import { env } from "cloudflare:workers";
import { canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, JPEG, addMember, api, call, createProject, createText, json, makeEnv, storageOf, upload } from "./helpers";
import { projectStorageBytes } from "../src/storage";

const post = (path: string, body: unknown, as = ALICE, opts: { env?: any } = {}) => call(api(path), { method: "POST", body, as, ...opts });
const put = (path: string, body: unknown, as = ALICE) => call(api(path), { method: "PUT", body, as });
const roles = async (pid: string) => Object.fromEntries((await json(await call(api(`/projects/${pid}/members`)))).members.map((m: any) => [m.subject, m.role]));

async function projectWithBytes() {
  const pid = await createProject(ALICE, "Owned");
  const tid = await createText(ALICE, pid);
  expect((await upload(api(`/texts/${tid}/pages`), JPEG(4000), ALICE, { query: { filename: "p.jpg" } })).status).toBe(201);
  await addMember(ALICE, pid, BOB, "editor");
  await addMember(ALICE, pid, CAROL, "viewer");
  return { pid, tid };
}

describe("member roles", () => {
  it("the owner switches a member between editor and viewer; the owner's own role is fixed", async () => {
    const { pid } = await projectWithBytes();
    expect((await put(`/projects/${pid}/members/${CAROL}`, { role: "editor" })).status).toBe(200);
    expect((await put(`/projects/${pid}/members/${BOB}`, { role: "viewer" })).status).toBe(200);
    expect(await roles(pid)).toMatchObject({ [ALICE]: "owner", [BOB]: "viewer", [CAROL]: "editor" });
    expect((await put(`/projects/${pid}/members/${ALICE}`, { role: "editor" })).status).toBe(409);
    for (const role of ["owner", "admin", 5]) expect((await put(`/projects/${pid}/members/${BOB}`, { role })).status).toBe(400);
    // The new viewer lost editing at once.
    expect((await post(`/projects/${pid}/texts`, { name: "x" }, BOB)).status).toBe(403);
  });
});

describe("ownership transfer needs the new owner's consent", () => {
  const offer = (pid: string, to: string, as = ALICE) => post(`/projects/${pid}/transfer`, { subject: to }, as);
  const accept = (id: string, as: string, opts: { env?: any } = {}) => post(`/transfers/${id}/accept`, {}, as, opts);
  const totals = async () => (await storageOf(ALICE)) + (await storageOf(BOB)) + (await storageOf(CAROL));

  it("an offer moves nothing; only the member's own accept moves ownership and storage; the old owner stays as editor", async () => {
    const { pid } = await projectWithBytes();
    const bytes = await projectStorageBytes(env.DB, pid);
    const [aliceBefore, bobBefore] = [await storageOf(ALICE), await storageOf(BOB)];
    const res = await offer(pid, BOB);
    expect(res.status).toBe(201);
    const { offer: o } = await json(res);
    // Nothing changed yet.
    expect(await roles(pid)).toMatchObject({ [ALICE]: "owner", [BOB]: "editor" });
    expect([await storageOf(ALICE), await storageOf(BOB)]).toEqual([aliceBefore, bobBefore]);
    // Both sides see the pending offer; Bob was notified.
    expect((await json(await call(api(`/projects/${pid}/transfer`)))).offer).toMatchObject({ id: o.id, to_subject: BOB });
    expect((await json(await call(api("/transfers"), { as: BOB }))).offers).toEqual([expect.objectContaining({ id: o.id, project_id: pid, project_name: "Owned" })]);
    expect((await json(await call(api("/notifications"), { as: BOB }))).notifications[0].title).toMatch(/offered you ownership of "Owned"/);
    // Only Bob can answer it.
    for (const who of [ALICE, CAROL]) expect((await accept(o.id, who)).status).toBe(404);
    expect(await json(await accept(o.id, BOB))).toEqual({ project_id: pid, owner: BOB, previous_owner_role: "editor" });
    expect(await roles(pid)).toMatchObject({ [ALICE]: "editor", [BOB]: "owner", [CAROL]: "viewer" });
    expect(await storageOf(ALICE)).toBe(aliceBefore - bytes);
    expect(await storageOf(BOB)).toBe(bobBefore + bytes);
    expect((await json(await call(api("/notifications")))).notifications[0].title).toMatch(/accepted ownership of "Owned"; you are now an editor/);
    // The offer is gone; accepting again does nothing.
    expect((await accept(o.id, BOB)).status).toBe(404);
    expect(await storageOf(BOB)).toBe(bobBefore + bytes);
    // New uploads are charged to the new owner.
    const tid = (await json(await post(`/projects/${pid}/texts`, { name: "New" }, BOB))).text.id;
    const before = await storageOf(BOB);
    await upload(api(`/texts/${tid}/pages`), JPEG(500), ALICE, { query: { filename: "q.jpg" } });
    expect(await storageOf(BOB)).toBe(before + 500);
  });

  it("one pending offer per project; revoke, decline and expiry each end it; accept after revoke fails", async () => {
    const { pid } = await projectWithBytes();
    const { offer: o } = await json(await offer(pid, BOB));
    expect((await offer(pid, CAROL)).status).toBe(409);
    expect((await call(api(`/projects/${pid}/transfer`), { method: "DELETE" })).status).toBe(200);
    expect((await accept(o.id, BOB)).status).toBe(404); // accept after revoke
    const { offer: o2 } = await json(await offer(pid, CAROL));
    expect((await post(`/transfers/${o2.id}/decline`, {}, CAROL)).status).toBe(200);
    expect((await accept(o2.id, CAROL)).status).toBe(404);
    const { offer: o3 } = await json(await offer(pid, BOB));
    await env.DB.prepare("UPDATE transfer_offers SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1").bind(o3.id).run();
    expect((await accept(o3.id, BOB)).status).toBe(410);
    expect((await offer(pid, CAROL)).status).toBe(201); // an expired offer gives way
    expect(await roles(pid)).toMatchObject({ [ALICE]: "owner" });
  });

  it("refuses offers to a non-member and to the owner; a member without room cannot accept, and the offer stays pending", async () => {
    const { pid } = await projectWithBytes();
    expect((await offer(pid, canonicalTestSubject("zed"))).status).toBe(404);
    expect((await offer(pid, "not-a-subject")).status).toBe(400);
    expect((await offer(pid, ALICE)).status).toBe(409);
    const { offer: o } = await json(await offer(pid, BOB));
    const before = [await storageOf(ALICE), await storageOf(BOB), JSON.stringify(await roles(pid))];
    const res = await accept(o.id, BOB, { env: await makeEnv({ STORAGE_QUOTA_BYTES: "100" }) });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({ code: "transfer_quota_exceeded", message: expect.stringMatching(/not have enough storage/) });
    expect([await storageOf(ALICE), await storageOf(BOB), JSON.stringify(await roles(pid))]).toEqual(before);
    expect((await json(await call(api("/transfers"), { as: BOB }))).offers).toHaveLength(1); // still pending, claim released
    expect((await accept(o.id, BOB)).status).toBe(200);
  });

  it("a claim abandoned mid-flight blocks nothing: revoke, a new offer, expiry cleanup and a later accept all work", async () => {
    const { pid } = await projectWithBytes();
    const leave = async (id: string) => env.DB.prepare("UPDATE transfer_offers SET claim_nonce = ?1, claim_bytes = 1 WHERE id = ?2").bind(crypto.randomUUID(), id).run();
    // A later accept succeeds over a leftover claim, and moves the real bytes.
    const bytes = await projectStorageBytes(env.DB, pid);
    const bobBefore = await storageOf(BOB);
    let { offer: o } = await json(await offer(pid, BOB));
    await leave(o.id);
    expect((await json(await call(api("/transfers"), { as: BOB }))).offers).toHaveLength(1);
    expect((await accept(o.id, BOB)).status).toBe(200);
    expect(await storageOf(BOB)).toBe(bobBefore + bytes);
    // Revoke and a new offer, over a leftover claim (Bob owns it now).
    ({ offer: o } = await json(await offer(pid, ALICE, BOB)));
    await leave(o.id);
    expect((await call(api(`/projects/${pid}/transfer`), { method: "DELETE", as: BOB })).status).toBe(200);
    ({ offer: o } = await json(await offer(pid, CAROL, BOB)));
    await leave(o.id);
    await env.DB.prepare("UPDATE transfer_offers SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1").bind(o.id).run();
    expect((await offer(pid, ALICE, BOB)).status).toBe(201); // expiry cleanup ignores the leftover claim
    // Declining over a leftover claim also works.
    const { offer: cur } = await json(await call(api(`/projects/${pid}/transfer`), { as: BOB }));
    await leave(cur.id);
    expect((await post(`/transfers/${cur.id}/decline`, {}, ALICE)).status).toBe(200);
  });

  it("an accept that fails after claiming (no room) leaves no claim behind", async () => {
    const { pid } = await projectWithBytes();
    const { offer: o } = await json(await offer(pid, BOB));
    expect((await accept(o.id, BOB, { env: await makeEnv({ STORAGE_QUOTA_BYTES: "100" }) })).status).toBe(409);
    const row = await env.DB.prepare("SELECT claim_nonce, claim_bytes FROM transfer_offers WHERE id = ?1").bind(o.id).first();
    expect(row).toEqual({ claim_nonce: null, claim_bytes: null });
  });

  it("two concurrent accepts of one offer: exactly one moves the storage, once", async () => {
    const { pid } = await projectWithBytes();
    const bytes = await projectStorageBytes(env.DB, pid);
    const total = await totals();
    const bobBefore = await storageOf(BOB);
    const { offer: o } = await json(await offer(pid, BOB));
    const results = await Promise.all([accept(o.id, BOB), accept(o.id, BOB), accept(o.id, BOB)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect([404, 409]).toContain(r.status);
    expect(await storageOf(BOB)).toBe(bobBefore + bytes);
    expect(await totals()).toBe(total);
    expect(Object.values(await roles(pid)).filter((r) => r === "owner")).toHaveLength(1);
  });

  it("an accept racing a revoke: either the move happens once or not at all", async () => {
    const { pid } = await projectWithBytes();
    const total = await totals();
    const { offer: o } = await json(await offer(pid, BOB));
    await Promise.all([accept(o.id, BOB), call(api(`/projects/${pid}/transfer`), { method: "DELETE" })]);
    expect(await totals()).toBe(total);
    const r = await roles(pid);
    expect([r[ALICE], r[BOB]].sort()).toEqual(["editor", "owner"]);
  });
});

describe("leaving a project ends what it offered you", () => {
  const offer = (pid: string, to: string) => post(`/projects/${pid}/transfer`, { subject: to });

  for (const how of ["removed by the owner", "leaving"] as const) {
    it(`a member ${how} loses the transfer offer made to them`, async () => {
      const { pid } = await projectWithBytes();
      const { offer: o } = await json(await offer(pid, BOB));
      const res = how === "leaving"
        ? await call(api(`/projects/${pid}/members/${BOB}`), { method: "DELETE", as: BOB })
        : await call(api(`/projects/${pid}/members/${BOB}`), { method: "DELETE" });
      expect(res.status).toBe(200);
      // Bob no longer sees the project's name in his offers, cannot answer, and the owner may offer to someone else.
      expect((await json(await call(api("/transfers"), { as: BOB }))).offers).toEqual([]);
      expect((await post(`/transfers/${o.id}/accept`, {}, BOB)).status).toBe(404);
      expect((await post(`/transfers/${o.id}/decline`, {}, BOB)).status).toBe(404);
      expect((await json(await call(api(`/projects/${pid}/transfer`)))).offer).toBeNull();
      expect((await offer(pid, CAROL)).status).toBe(201);
    });
  }

  it("a reply notifies the thread's author only while they are a member", async () => {
    const { pid, tid } = await projectWithBytes();
    const root = (await json(await post(`/texts/${tid}/annotations`, { body: "Bob's note", anchor_type: "global" }, BOB))).annotation;
    expect((await call(api(`/projects/${pid}/members/${BOB}`), { method: "DELETE", as: BOB })).status).toBe(200);
    expect((await post(`/texts/${tid}/annotations/${root.id}/replies`, { body: "Private follow-up" })).status).toBe(201);
    const notes = (await json(await call(api("/notifications?all=1"), { as: BOB }))).notifications;
    expect(notes.filter((n: any) => n.type === "comment_reply")).toEqual([]);
  });
});
