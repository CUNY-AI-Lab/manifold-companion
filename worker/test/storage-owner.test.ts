// Storage is charged to whoever owns the project when the bytes land, even if
// ownership moved while the request was running (DESIGN 6, Transfer ownership).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ProjectRow } from "../src/authz";
import { pruneVersions } from "../src/content";
import { deleteRowAndRelease, projectStorageBytes } from "../src/storage";
import { deleteTextObjects } from "../src/text-ops";
import { ALICE, BOB, CAROL, JPEG, addMember, api, call, createProject, createText, gatedUpload, json, makeEnv, seedPage, storageDrift, storageOf, upload } from "./helpers";

const offerTo = async (pid: string, to: string, as = ALICE): Promise<string> => {
  const res = await call(api(`/projects/${pid}/transfer`), { method: "POST", as, body: { subject: to } });
  expect(res.status).toBe(201);
  return (await json(res)).offer.id as string;
};
const accept = (offerId: string, as: string, e?: Awaited<ReturnType<typeof makeEnv>>) => call(api(`/transfers/${offerId}/accept`), { method: "POST", as, body: {}, ...(e ? { env: e } : {}) });
const projectRow = async (pid: string) => (await env.DB.prepare("SELECT * FROM projects WHERE id = ?1").bind(pid).first<ProjectRow>())!;

async function sharedProject() {
  const pid = await createProject(ALICE, "Shared");
  const tid = await createText(ALICE, pid);
  expect((await upload(api(`/texts/${tid}/pages`), JPEG(4000), ALICE, { query: { filename: "p.jpg" } })).status).toBe(201);
  await addMember(ALICE, pid, BOB, "editor");
  await addMember(ALICE, pid, CAROL, "editor");
  return { pid, tid };
}

describe("an upload in flight when ownership moves", () => {
  it("is charged to the new owner, and both counters keep the invariant", async () => {
    const { pid, tid } = await sharedProject();
    const offer = await offerTo(pid, BOB);
    const up = await gatedUpload(api(`/texts/${tid}/pages`), JPEG(3000), CAROL);
    await up.reserved;
    expect((await accept(offer, BOB)).status).toBe(200);
    up.open();
    expect((await up.done).status).toBe(201);
    expect(await storageDrift()).toEqual([]);
    expect(await storageOf(ALICE)).toBe(0);
    expect(await storageOf(BOB)).toBe(await projectStorageBytes(env.DB, pid));
  });

  it("counts toward the room the new owner needs to accept", async () => {
    const { pid, tid } = await sharedProject();
    const offer = await offerTo(pid, BOB);
    const up = await gatedUpload(api(`/texts/${tid}/pages`), JPEG(3000), CAROL);
    await up.reserved;
    // Bob has room for the stored 4000 bytes, not for those plus the 3000 on their way.
    const res = await accept(offer, BOB, await makeEnv({ STORAGE_QUOTA_BYTES: "5000" }));
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("transfer_quota_exceeded");
    up.open();
    expect((await up.done).status).toBe(201);
    expect(await storageDrift()).toEqual([]);
    expect(await storageOf(BOB)).toBe(0);
  });

  it("a failed upload gives its reservation back to the new owner", async () => {
    const { pid, tid } = await sharedProject();
    const offer = await offerTo(pid, BOB);
    // Declares 3000 bytes, the gate then sends 10: the Worker refuses after the transfer.
    const up = await gatedUpload(api(`/texts/${tid}/pages`), JPEG(10), CAROL, { query: { size: "3000" } });
    await up.reserved;
    expect((await accept(offer, BOB)).status).toBe(200);
    up.open();
    expect((await up.done).status).toBe(400);
    expect(await storageDrift()).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_reservations").first()).toEqual({ n: 0 });
  });
});

describe("a delete authorized before ownership moved releases from the new owner", () => {
  // Each request reads the project row (and so its owner) once, at authorization.
  // A transfer can commit between that read and the deleting batch.
  async function transferredAfterRead() {
    const { pid, tid } = await sharedProject();
    const stale = await projectRow(pid);
    expect((await accept(await offerTo(pid, BOB), BOB)).status).toBe(200);
    expect(await storageDrift()).toEqual([]);
    return { pid, tid, stale };
  }

  it("deleting a text", async () => {
    const { tid, stale } = await transferredAfterRead();
    expect(await deleteTextObjects(await makeEnv(), stale, tid)).toBe(true);
    expect(await storageDrift()).toEqual([]);
    expect(await storageOf(BOB)).toBe(0);
  });

  it("deleting a page", async () => {
    const { tid, stale } = await transferredAfterRead();
    const page = (await env.DB.prepare("SELECT id FROM pages WHERE text_id = ?1").bind(tid).first<{ id: string }>())!;
    expect(await deleteRowAndRelease(env.DB, stale.id, "pages", page.id, "image_bytes")).toBe(true);
    expect(await storageDrift()).toEqual([]);
  });

  it("pruning versions", async () => {
    const { pid, tid } = await sharedProject();
    const page = await seedPage(tid, { filename: "v.jpg", ocr: "v0", pageNumber: 2 });
    for (let i = 1; i <= 22; i += 1) expect((await call(api(`/texts/${tid}/pages/${page}`), { method: "POST", body: { text: `v${i} ${"x".repeat(50)}` } })).status).toBe(200);
    const stale = await projectRow(pid);
    expect((await accept(await offerTo(pid, BOB), BOB)).status).toBe(200);
    // Push two more versions in directly so the prune has something to remove.
    for (let i = 0; i < 2; i += 1) {
      await env.DB.prepare("INSERT INTO text_versions (id, text_id, content_type, page_filename, r2_key, bytes, created_at) VALUES (?1, ?2, 'page', 'v.jpg', ?3, 100, '2099-01-01T00:00:00Z')").bind(crypto.randomUUID(), tid, `p/${pid}/t/${tid}/v/${crypto.randomUUID()}`).run();
      await env.DB.prepare("UPDATE profiles SET storage_bytes = storage_bytes + 100 WHERE subject = ?1").bind(BOB).run();
    }
    expect(await storageDrift()).toEqual([]);
    await pruneVersions(await makeEnv(), stale, tid, "page", "v.jpg");
    expect(await storageDrift()).toEqual([]);
  });

  it("an edit that shrinks a translation", async () => {
    const { pid } = await sharedProject();
    const tid = await createText(ALICE, pid, "Translated");
    expect((await call(api(`/texts/${tid}/translation`), { method: "PUT", body: { translation: "x".repeat(3000) } })).status).toBe(200);
    expect(await storageDrift()).toEqual([]);
    const { writeContent } = await import("../src/content");
    const staleProject = await projectRow(pid);
    const staleText = (await env.DB.prepare("SELECT * FROM texts WHERE id = ?1").bind(tid).first())!;
    expect((await accept(await offerTo(pid, BOB), BOB)).status).toBe(200);
    await writeContent(await makeEnv(), staleProject, staleText as never, "translation", "short", ALICE);
    expect(await storageDrift()).toEqual([]);
  });
});
