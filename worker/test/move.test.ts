// Moving texts to another project (DESIGN 6, "Move a text").
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, JPEG, PDF, PNG, addMember, api, call, createProject, createText, gatedUpload, hookedDb, json, makeEnv, objectDrift, storageDrift, storageOf, upload } from "./helpers";
import { projectPrefix, textPrefix } from "../src/r2-keys";
import { projectStorageBytes } from "../src/storage";

const r2Keys = async (prefix = "") => (await env.FILES.list({ prefix })).objects.map((o) => o.key);
const move = (src: string, body: unknown, as = ALICE, e?: Awaited<ReturnType<typeof makeEnv>>) => call(api(`/projects/${src}/texts/move`), { method: "POST", body, as, ...(e ? { env: e } : {}) });
const clean = async () => {
  expect(await storageDrift()).toEqual([]);
  expect(await objectDrift()).toEqual({ dangling: [], orphans: [] });
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_reservations").first<{ n: number }>())!.n).toBe(0);
};

/** An image text with two pages, a page version, metadata, settings and a comment. */
async function richImageText(owner = ALICE, pid?: string) {
  const src = pid ?? (await createProject(owner, "Source"));
  const tid = await createText(owner, src, "Letter");
  const p1 = (await json(await upload(api(`/texts/${tid}/pages`), JPEG(400), owner, { query: { filename: "a.jpg" } }))).page.id;
  await upload(api(`/texts/${tid}/pages`), PNG(300), owner, { query: { filename: "b.png" } });
  await call(api(`/texts/${tid}/pages/${p1}`), { method: "POST", as: owner, body: { text: "first reading" } });
  await call(api(`/texts/${tid}/pages/${p1}`), { method: "POST", as: owner, body: { text: "corrected reading" } });
  await call(api(`/texts/${tid}/save`), { method: "POST", as: owner, body: { text: "# Full text" } });
  await call(api(`/texts/${tid}/metadata`), { method: "POST", as: owner, body: { dc_title: "A letter", dc_creator: "Someone" } });
  await call(api(`/texts/${tid}/settings`), { method: "POST", as: owner, body: { temperature: 0.3 } });
  const comment = await call(api(`/texts/${tid}/annotations`), { method: "POST", as: owner, body: { anchor_type: "global", body: "Check page two." } });
  expect(comment.status).toBe(201);
  return { src, tid, p1 };
}

describe("moving texts to another project", () => {
  it("carries pages, versions, full text, metadata and settings under a new id; deletes the comments; storage stays put for one owner", async () => {
    const { src, tid, p1 } = await richImageText();
    const dst = await createProject(ALICE, "Destination");
    const before = await storageOf(ALICE);
    const bytes = await projectStorageBytes(env.DB, src);

    const preview = await json(await move(src, { textIds: [tid], to: dst, preview: true }));
    expect(preview.preview.totals).toEqual({ texts: 1, pages: 2, versions: 1, comments: 1, bytes });
    expect(preview.preview.destination).toEqual({ id: dst, name: "Destination", same_owner: true });
    expect((await json(await call(api(`/texts/${tid}`)))).text.project_id).toBe(src); // a preview changes nothing

    const res = await move(src, { textIds: [tid], to: dst });
    expect(res.status).toBe(200);
    const { moved, failed } = await json(res);
    expect(failed).toEqual([]);
    expect(moved).toEqual([{ from: tid, to: expect.any(String), name: "Letter", comments_deleted: 1 }]);
    const nid = moved[0].to;
    expect(nid).not.toBe(tid);

    expect((await call(api(`/texts/${tid}`))).status).toBe(404);
    const after = await json(await call(api(`/texts/${nid}`)));
    expect(after.text).toMatchObject({ project_id: dst, name: "Letter", has_compiled: true });
    expect(after.pages.map((p: { id: string; filename: string; ocr_text: string | null }) => [p.id, p.filename, p.ocr_text])).toEqual([[p1, "a.jpg", "corrected reading"], [expect.any(String), "b.png", null]]);
    expect((await call(api(`/texts/${nid}/pages/${p1}/image`))).status).toBe(200);
    expect((await json(await call(api(`/texts/${nid}/compiled`)))).text).toBe("# Full text");
    const [version] = (await json(await call(api(`/texts/${nid}/versions?type=page`)))).versions;
    expect((await json(await call(api(`/texts/${nid}/versions/${version.id}`)))).version.content).toBe("first reading");
    expect((await json(await call(api(`/texts/${nid}/metadata`)))).metadata).toMatchObject({ dc_title: "A letter", dc_creator: "Someone" });
    expect((await json(await call(api(`/texts/${nid}/settings`)))).settings).toMatchObject({ temperature: 0.3 });
    expect((await json(await call(api(`/texts/${nid}/annotations`)))).annotations).toEqual([]);

    // Objects: all under the destination's new text prefix; nothing left under the source.
    expect(await r2Keys(projectPrefix(src))).toEqual([]);
    const moved_ = await r2Keys(projectPrefix(dst));
    expect(moved_.length).toBeGreaterThanOrEqual(4);
    expect(moved_.every((k) => k.startsWith(textPrefix(dst, nid)))).toBe(true);
    expect(await storageOf(ALICE)).toBe(before);
    expect(await projectStorageBytes(env.DB, dst)).toBe(bytes);
    expect(await projectStorageBytes(env.DB, src)).toBe(0);
    await clean();

    // Search follows the text to its project; the destination lists it last.
    const hits = (await json(await call(api("/search?q=corrected")))).results;
    expect(hits.map((h: { text_id?: string; id?: string; project_id: string }) => [h.text_id ?? h.id, h.project_id])).toEqual([[nid, dst]]);
    expect((await json(await call(api(`/projects/${dst}/texts`)))).texts.map((t: { id: string }) => t.id)).toEqual([nid]);
  });

  it("between owners: the bytes leave the source owner and reach the destination owner; refused when the destination owner has no room", async () => {
    const { src, tid } = await richImageText(ALICE);
    const bobs = await createProject(BOB, "Bob's");
    await addMember(BOB, bobs, ALICE, "editor");
    const bytes = await projectStorageBytes(env.DB, src);
    const tight = await makeEnv({ STORAGE_QUOTA_BYTES: String(bytes - 1) });
    const refused = await move(src, { textIds: [tid], to: bobs }, ALICE, tight);
    expect(refused.status).toBe(200);
    expect((await json(refused)).failed).toEqual([{ id: tid, name: "Letter", code: "storage_quota_exceeded", message: expect.stringMatching(/destination project's owner/) }]);
    expect((await json(await call(api(`/texts/${tid}`)))).text.project_id).toBe(src);
    await clean();

    expect((await json(await move(src, { textIds: [tid], to: bobs }))).moved).toHaveLength(1);
    expect(await storageOf(ALICE)).toBe(0);
    expect(await storageOf(BOB)).toBe(bytes);
    expect(await projectStorageBytes(env.DB, bobs)).toBe(bytes);
    await clean();
  });

  it("PDF texts carry their source PDF, HTML versions and figures", async () => {
    const src = await createProject(ALICE, "PDF A", { project_type: "pdf_to_html" });
    const dst = await createProject(ALICE, "PDF B", { project_type: "pdf_to_html" });
    const tid = await createText(ALICE, src, "Chapter");
    await upload(api(`/texts/${tid}/source-pdf`), PDF(900), ALICE, { method: "PUT", query: { filename: "c.pdf" } });
    await call(api(`/texts/${tid}/html`), { method: "PUT", body: { html_content: "<p>one</p>" } });
    await call(api(`/texts/${tid}/html`), { method: "PUT", body: { html_content: "<p>two</p>" } });
    const fig = (await json(await upload(api(`/texts/${tid}/figures`), PNG(120), ALICE, { query: { filename: "f.png" } }))).figure.id;
    const { moved } = await json(await move(src, { textIds: [tid], to: dst }));
    const nid = moved[0].to;
    expect((await json(await call(api(`/texts/${nid}/html`)))).html_content).toBe("<p>two</p>");
    expect((await call(api(`/texts/${nid}/source-pdf`))).status).toBe(200);
    expect((await call(api(`/texts/${nid}/figures/${fig}`))).status).toBe(200);
    expect((await json(await call(api(`/texts/${nid}/versions?type=html`)))).versions).toHaveLength(1);
    await clean();
  });

  it("authorizes both projects, keeps to one kind of project, and takes only the source's texts", async () => {
    const { src, tid } = await richImageText(ALICE);
    const bobs = await createProject(BOB, "Bob's");
    await addMember(BOB, bobs, ALICE, "viewer");
    const strangers = await createProject(CAROL, "Carol's");
    const pdf = await createProject(ALICE, "PDF", { project_type: "pdf_to_html" });
    const viewer = await move(src, { textIds: [tid], to: bobs });
    expect([viewer.status, (await json(viewer)).error.code]).toEqual([403, "insufficient_role"]);
    const stranger = await move(src, { textIds: [tid], to: strangers });
    expect([stranger.status, (await json(stranger)).error.code]).toEqual([404, "not_found"]);
    expect((await move(src, { textIds: [tid], to: crypto.randomUUID() })).status).toBe(404);
    expect((await json(await move(src, { textIds: [tid], to: pdf }))).error.code).toBe("wrong_project_type");
    expect((await json(await move(src, { textIds: [tid], to: src }))).error.code).toBe("same_project");
    const elsewhere = await createText(CAROL, strangers, "Not mine");
    const own = await createProject(ALICE, "Own");
    expect((await move(src, { textIds: [elsewhere], to: own })).status).toBe(400);
    for (const body of [{}, { textIds: [], to: own }, { textIds: [tid] }, { textIds: ["x"], to: own }]) expect((await move(src, body)).status, JSON.stringify(body)).toBe(400);
    expect((await json(await call(api(`/texts/${tid}`)))).text.project_id).toBe(src);
    expect((await json(await call(api(`/texts/${elsewhere}`), { as: CAROL }))).text.project_id).toBe(strangers);
    await clean();
  });

  it("holds the destination to its text and page caps; a refused text stays whole where it was", async () => {
    const { src, tid } = await richImageText(ALICE);
    const dst = await createProject(ALICE, "Full");
    await createText(ALICE, dst, "Already here");
    const one = await json(await move(src, { textIds: [tid], to: dst }, ALICE, await makeEnv({ MAX_TEXTS_PER_PROJECT: "1" })));
    expect(one.failed[0].code).toBe("text_limit_reached");
    const pages = await json(await move(src, { textIds: [tid], to: dst }, ALICE, await makeEnv({ MAX_PROJECT_PAGES: "1" })));
    expect(pages.failed[0].code).toBe("page_limit_reached");
    await clean();
  });

  it("a write racing the move either lands before it (and the move is refused) or fails cleanly after it", async () => {
    // (1) A page uploaded into the text after the move read it: the move is refused, nothing changes.
    const { src, tid } = await richImageText(ALICE);
    const dst = await createProject(ALICE, "Dest");
    const raced = hookedDb(env.DB, /SELECT r2_key AS k, bytes AS b FROM text_versions/, () => upload(api(`/texts/${tid}/pages`), JPEG(77), ALICE, { query: { filename: "late.jpg" } }));
    const refused = await json(await move(src, { textIds: [tid], to: dst }, ALICE, await makeEnv({ DB: raced })));
    expect(refused.failed).toEqual([{ id: tid, name: "Letter", code: "move_conflict", message: expect.any(String) }]);
    expect((await json(await call(api(`/texts/${tid}`)))).pages.map((p: { filename: string }) => p.filename)).toEqual(["a.jpg", "b.png", "late.jpg"]);
    await clean();

    // (2) An upload in flight while the move commits: it is refused afterwards and gives its quota back.
    const g = await gatedUpload(api(`/texts/${tid}/pages`), JPEG(500), ALICE, { query: { filename: "slow.jpg" } });
    await g.reserved;
    const { moved } = await json(await move(src, { textIds: [tid], to: dst }));
    expect(moved).toHaveLength(1);
    g.open();
    expect((await g.done).status).toBe(404);
    await clean();

    // (3) A page edit authorized on the old text cannot write the moved page.
    const page = (await json(await call(api(`/texts/${moved[0].to}`)))).pages[0];
    const edit = await call(api(`/texts/${tid}/pages/${page.id}`), { method: "POST", body: { text: "written to the old text" } });
    expect(edit.status).toBe(404);
    expect((await json(await call(api(`/texts/${moved[0].to}`)))).pages[0].ocr_text).toBe("corrected reading");
    await clean();
  });

  it("a page edit or delete authorized before the move and written after it does not touch the moved page", async () => {
    for (const action of ["edit", "delete"] as const) {
      const { src, tid, p1 } = await richImageText(ALICE);
      const dst = await createProject(ALICE, `Dest ${action}`);
      let to = "";
      // The move runs right after the request has read the page (authorized against the old text).
      const db = hookedDb(env.DB, /SELECT \* FROM pages WHERE id = \?1 AND text_id = \?2/, async () => { to = (await json(await move(src, { textIds: [tid], to: dst }))).moved[0].to; });
      const e = await makeEnv({ DB: db });
      const res = action === "edit"
        ? await call(api(`/texts/${tid}/pages/${p1}`), { method: "POST", body: { text: "late edit" }, env: e })
        : await call(api(`/texts/${tid}/pages/${p1}`), { method: "DELETE", env: e });
      expect(to, action).not.toBe("");
      expect([404, 409], action).toContain(res.status);
      const page = (await json(await call(api(`/texts/${to}`)))).pages.find((p: { id: string }) => p.id === p1);
      expect(page?.ocr_text, action).toBe("corrected reading");
      await clean();
    }
  });

  it("two moves of one text at once: one moves it, the other finds it gone; nothing is duplicated", async () => {
    const { src, tid } = await richImageText(ALICE);
    const [d1, d2] = [await createProject(ALICE, "D1"), await createProject(ALICE, "D2")];
    const [a, b] = await Promise.all([move(src, { textIds: [tid], to: d1 }), move(src, { textIds: [tid], to: d2 })]);
    const outcomes = [await json(a), await json(b)];
    const statuses = outcomes.map((o) => (o.moved?.length ? "moved" : o.failed?.[0]?.code ?? o.error?.code));
    expect(statuses.filter((s) => s === "moved")).toHaveLength(1);
    expect(statuses.filter((s) => s !== "moved").every((s) => ["not_found", "move_conflict", "invalid_request"].includes(s))).toBe(true);
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM texts WHERE name = 'Letter' AND project_id IN (?1, ?2, ?3)").bind(src, d1, d2).first<{ n: number }>())!.n;
    expect(n).toBe(1);
    await clean();
  });

  it("moves several texts in order, each whole, and reports each", async () => {
    const src = await createProject(ALICE, "Many");
    const ids = [await createText(ALICE, src, "One"), await createText(ALICE, src, "Two"), await createText(ALICE, src, "Three")];
    for (const id of ids) await upload(api(`/texts/${id}/pages`), JPEG(50), ALICE, { query: { filename: "p.jpg" } });
    const dst = await createProject(ALICE, "Two only");
    const r = await json(await move(src, { textIds: ids, to: dst }, ALICE, await makeEnv({ MAX_PROJECT_PAGES: "2" })));
    expect(r.moved.map((m: { name: string }) => m.name)).toEqual(["One", "Two"]);
    expect(r.failed.map((f: { name: string; code: string }) => [f.name, f.code])).toEqual([["Three", "page_limit_reached"]]);
    expect((await json(await call(api(`/projects/${dst}/texts`)))).texts.map((t: { name: string }) => t.name)).toEqual(["One", "Two"]);
    await clean();
  });
});

describe("moving texts: access is re-checked inside each text's transaction", () => {
  it("a mover removed from the source mid-request moves nothing more out of it", async () => {
    const src = await createProject(ALICE, "Alice's");
    await addMember(ALICE, src, BOB, "editor");
    const ids = [await createText(ALICE, src, "One"), await createText(ALICE, src, "Two")];
    for (const id of ids) await upload(api(`/texts/${id}/pages`), JPEG(60), ALICE, { query: { filename: "p.jpg" } });
    const bobs = await createProject(BOB, "Bob's");
    // Right after the first text's batch, Alice removes Bob from her project.
    const db = hookedDb(env.DB, /SELECT html_key, compiled_key, translation_key, source_pdf_key FROM texts WHERE id = \?1/, async () => {
      expect((await call(api(`/projects/${src}/members/${BOB}`), { method: "DELETE", as: ALICE })).status).toBe(200);
    });
    const r = await json(await move(src, { textIds: ids, to: bobs }, BOB, await makeEnv({ DB: db })));
    expect(r.moved.map((m: { name: string }) => m.name)).toEqual(["One"]);
    expect(r.failed.map((f: { name: string; code: string }) => [f.name, f.code])).toEqual([["Two", "insufficient_role"]]);
    expect((await json(await call(api(`/texts/${ids[1]}`), { as: ALICE }))).text.project_id).toBe(src);
    await clean();
  });

  it("a mover removed from the destination, or made a viewer there, mid-request adds nothing more to it", async () => {
    for (const change of ["remove", "viewer"] as const) {
      const src = await createProject(ALICE, `Mine ${change}`);
      const ids = [await createText(ALICE, src, "One"), await createText(ALICE, src, "Two")];
      const carols = await createProject(CAROL, `Carol's ${change}`);
      await addMember(CAROL, carols, ALICE, "editor");
      const db = hookedDb(env.DB, /SELECT html_key, compiled_key, translation_key, source_pdf_key FROM texts WHERE id = \?1/, async () => {
        const res = change === "remove"
          ? await call(api(`/projects/${carols}/members/${ALICE}`), { method: "DELETE", as: CAROL })
          : await call(api(`/projects/${carols}/members/${ALICE}`), { method: "PUT", as: CAROL, body: { role: "viewer" } });
        expect(res.status, change).toBe(200);
      });
      const r = await json(await move(src, { textIds: ids, to: carols }, ALICE, await makeEnv({ DB: db })));
      expect(r.moved.map((m: { name: string }) => m.name), change).toEqual(["One"]);
      expect(r.failed.map((f: { name: string; code: string }) => [f.name, f.code]), change).toEqual([["Two", "insufficient_role"]]);
      expect((await json(await call(api(`/texts/${ids[1]}`)))).text.project_id, change).toBe(src);
      await clean();
    }
  });

  it("access lost between the plan and the batch of a single text: refused, nothing changes", async () => {
    const src = await createProject(ALICE, "Alice's single");
    await addMember(ALICE, src, BOB, "editor");
    const tid = await createText(ALICE, src, "Only");
    await upload(api(`/texts/${tid}/pages`), JPEG(60), ALICE, { query: { filename: "p.jpg" } });
    const bobs = await createProject(BOB, "Bob's single");
    const db = hookedDb(env.DB, /SELECT r2_key AS k, bytes AS b FROM text_versions/, async () => {
      expect((await call(api(`/projects/${src}/members/${BOB}`), { method: "PUT", as: ALICE, body: { role: "viewer" } })).status).toBe(200);
    });
    const r = await json(await move(src, { textIds: [tid], to: bobs }, BOB, await makeEnv({ DB: db })));
    expect(r.moved).toEqual([]);
    expect(r.failed.map((f: { code: string }) => f.code)).toEqual(["insufficient_role"]);
    expect((await json(await call(api(`/texts/${tid}`), { as: ALICE }))).text.project_id).toBe(src);
    expect(await r2Keys(projectPrefix(bobs))).toEqual([]);
    await clean();
  });
});

describe("moving texts and retention", () => {
  it("a text moved into a project the sweep is deleting keeps the project: the move is an edit inside its own transaction", async () => {
    const { runRetentionSweep } = await import("../src/retention");
    const { addDays, nowIso } = await import("../src/util");
    const { src, tid } = await richImageText(ALICE);
    const dst = await createProject(ALICE, "Old destination");
    // The destination is past its retention date and was warned long ago.
    await env.DB.prepare("UPDATE projects SET last_edited_at = ?1, retention_warned_at = ?2 WHERE id = ?3").bind(addDays(nowIso(), -200), addDays(nowIso(), -20), dst).run();
    // The sweep runs right after the move's batch commits.
    let swept = -1;
    const db = hookedDb(env.DB, /SELECT html_key, compiled_key, translation_key, source_pdf_key FROM texts WHERE id = \?1/, async () => { swept = (await runRetentionSweep(await makeEnv())).deleted; });
    const r = await json(await move(src, { textIds: [tid], to: dst }, ALICE, await makeEnv({ DB: db })));
    expect(r.moved).toHaveLength(1);
    expect(swept).toBe(0);
    const after = await call(api(`/texts/${r.moved[0].to}`));
    expect(after.status).toBe(200);
    expect((await json(after)).pages).toHaveLength(2);
    const p = await env.DB.prepare("SELECT retention_warned_at FROM projects WHERE id = ?1").bind(dst).first<{ retention_warned_at: string | null }>();
    expect(p?.retention_warned_at).toBeNull();
    await clean();
  });
});

describe("moving texts: an interrupted move leaves no stored object behind", () => {
  /** FILES whose put runs `onPut(n)` after the n-th put, and whose delete can be made to fail (a Worker that died before its cleanup). */
  const files = (real: R2Bucket, opts: { onPut?: (n: number) => Promise<void>; deleteFails?: boolean }) => {
    let n = 0;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "put") return async (...a: Parameters<R2Bucket["put"]>) => { const r = await target.put(...a); n += 1; await opts.onPut?.(n); return r; };
        if (prop === "delete" && opts.deleteFails) return async () => { throw new Error("worker gone"); };
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };

  it("copies made by a move that never reached its batch are swept by the cron", async () => {
    const { processCleanup } = await import("../src/storage");
    const { src, tid } = await richImageText(ALICE);
    const dst = await createProject(ALICE, "Interrupted");
    // The Worker dies after the copies: the batch never commits and nothing it would have cleaned up runs.
    const dead = { ...env.DB, prepare: env.DB.prepare.bind(env.DB), batch: async () => { throw new Error("worker gone"); } } as unknown as D1Database;
    const e = await makeEnv({ DB: dead, FILES: files(env.FILES, { deleteFails: true }) });
    const { moveText, planText } = await import("../src/move");
    const srcRow = (await env.DB.prepare("SELECT * FROM projects WHERE id = ?1").bind(src).first())!;
    const dstRow = (await env.DB.prepare("SELECT * FROM projects WHERE id = ?1").bind(dst).first())!;
    const plan = (await planText(env.DB, srcRow as never, tid))!;
    await expect(moveText(e, ALICE, srcRow as never, dstRow as never, plan)).rejects.toThrow("worker gone");
    expect((await r2Keys(projectPrefix(dst))).length).toBeGreaterThan(0); // the orphans
    // Not yet: the copies of a move that may still be running are left alone...
    await processCleanup(await makeEnv());
    expect((await r2Keys(projectPrefix(dst))).length).toBeGreaterThan(0);
    // ...until the move could no longer commit.
    await processCleanup(await makeEnv(), Date.now() + 2 * 3600_000);
    expect(await r2Keys(projectPrefix(dst))).toEqual([]);
    expect((await json(await call(api(`/texts/${tid}`)))).text.project_id).toBe(src);
    expect(await objectDrift()).toEqual({ dangling: [], orphans: [] });
  });

  it("the cron running while a move copies does not touch its copies; a move whose pending mark was swept is refused", async () => {
    const { processCleanup } = await import("../src/storage");
    const { src, tid } = await richImageText(ALICE);
    const dst = await createProject(ALICE, "Cron mid-move");
    const e = await makeEnv({ FILES: files(env.FILES, { onPut: async (n) => { if (n === 1) await processCleanup(await makeEnv()); } }) });
    const { moved } = await json(await move(src, { textIds: [tid], to: dst }, ALICE, e));
    expect(moved).toHaveLength(1);
    expect((await call(api(`/texts/${moved[0].to}/pages/${(await json(await call(api(`/texts/${moved[0].to}`)))).pages[0].id}/image`))).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM r2_cleanup WHERE prefix LIKE ?1").bind(`${projectPrefix(dst)}%`).first<{ n: number }>())!.n).toBe(0);
    await clean();

    // The pending mark gone (the cron swept the copies of a move that took too long): the move does not commit.
    const second = await richImageText(ALICE);
    const e2 = await makeEnv({ FILES: files(env.FILES, { onPut: async (n) => { if (n === 1) await env.DB.prepare("DELETE FROM r2_cleanup WHERE prefix LIKE ?1").bind(`${projectPrefix(dst)}%`).run(); } }) });
    const r = await json(await move(second.src, { textIds: [second.tid], to: dst }, ALICE, e2));
    expect(r.failed.map((f: { code: string }) => f.code)).toEqual(["move_conflict"]);
    expect((await json(await call(api(`/texts/${second.tid}`)))).text.project_id).toBe(second.src);
    await clean();
  });
});
