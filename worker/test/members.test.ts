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

describe("ownership transfer", () => {
  it("moves ownership and the project's storage to the new owner; the old owner stays as editor", async () => {
    const { pid } = await projectWithBytes();
    const bytes = await projectStorageBytes(env.DB, pid);
    expect(bytes).toBeGreaterThan(0);
    const [aliceBefore, bobBefore] = [await storageOf(ALICE), await storageOf(BOB)];
    expect(await json(await post(`/projects/${pid}/transfer`, { subject: BOB }))).toEqual({ owner: BOB, previous_owner_role: "editor" });
    expect(await roles(pid)).toMatchObject({ [ALICE]: "editor", [BOB]: "owner", [CAROL]: "viewer" });
    expect(await storageOf(ALICE)).toBe(aliceBefore - bytes);
    expect(await storageOf(BOB)).toBe(bobBefore + bytes);
    expect((await json(await call(api(`/projects/${pid}`), { as: BOB }))).project.role).toBe("owner");
    // Alice is no longer the owner: she cannot delete it or transfer it back; Bob can.
    expect((await call(api(`/projects/${pid}`), { method: "DELETE" })).status).toBe(403);
    expect((await post(`/projects/${pid}/transfer`, { subject: ALICE })).status).toBe(403);
    const notes = (await json(await call(api("/notifications"), { as: BOB }))).notifications;
    expect(notes[0].title).toMatch(/made you the owner of "Owned"/);
    // New uploads are charged to the new owner.
    const tid = (await json(await post(`/projects/${pid}/texts`, { name: "New" }, BOB))).text.id;
    const before = await storageOf(BOB);
    await upload(api(`/texts/${tid}/pages`), JPEG(500), ALICE, { query: { filename: "q.jpg" } });
    expect(await storageOf(BOB)).toBe(before + 500);
  });

  it("refuses a non-member, the owner themselves, and a new owner without room; nothing changes", async () => {
    const { pid } = await projectWithBytes();
    const before = [await storageOf(ALICE), await storageOf(BOB), JSON.stringify(await roles(pid))];
    expect((await post(`/projects/${pid}/transfer`, { subject: "cail-v1-nobody" })).status).toBe(400);
    expect((await post(`/projects/${pid}/transfer`, { subject: canonicalTestSubject("zed") })).status).toBe(404); // valid subject, not a member
    expect((await post(`/projects/${pid}/transfer`, { subject: ALICE })).status).toBe(409);
    const tight = await makeEnv({ STORAGE_QUOTA_BYTES: "100" });
    const res = await post(`/projects/${pid}/transfer`, { subject: BOB }, ALICE, { env: tight });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("transfer_quota_exceeded");
    expect([await storageOf(ALICE), await storageOf(BOB), JSON.stringify(await roles(pid))]).toEqual(before);
  });

  it("two racing transfers to different members: exactly one wins and the storage adds up", async () => {
    const { pid } = await projectWithBytes();
    const bytes = await projectStorageBytes(env.DB, pid);
    const total = (await storageOf(ALICE)) + (await storageOf(BOB)) + (await storageOf(CAROL));
    const results = await Promise.all([post(`/projects/${pid}/transfer`, { subject: BOB }), post(`/projects/${pid}/transfer`, { subject: CAROL })]);
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(results.find((r) => r.status !== 200)!.status).toBeGreaterThanOrEqual(403);
    expect((await storageOf(ALICE)) + (await storageOf(BOB)) + (await storageOf(CAROL))).toBe(total);
    const owners = Object.entries(await roles(pid)).filter(([, r]) => r === "owner");
    expect(owners).toHaveLength(1);
    expect(await storageOf(owners[0]![0])).toBeGreaterThanOrEqual(bytes);
  });
});
