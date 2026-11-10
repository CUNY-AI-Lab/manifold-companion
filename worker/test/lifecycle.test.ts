import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, addMember, api, call, createProject, invite, json, makeEnv, redeem } from "./helpers";
import { runRetentionSweep } from "../src/retention";
import { deleteProject, processCleanup, projectStorageBytes, releaseReservation, reserveStorage, TOMBSTONE_KEEP_MS } from "../src/storage";
import { htmlKey, pageImageKey, projectPrefix, sourcePdfKey, versionKey } from "../src/r2-keys";
import { addDays, newId, nowIso } from "../src/util";
import indexModule from "../src/index";

/** Seed a text with every kind of stored content, as later phases will write it. */
async function seedContent(projectId: string, authorSubject: string) {
  const textId = newId();
  const pageId = newId();
  const versionId = newId();
  const now = nowIso();
  const keys = { page: pageImageKey(projectId, textId, pageId), html: htmlKey(projectId, textId), pdf: sourcePdfKey(projectId, textId), version: versionKey(projectId, textId, versionId) };
  await env.FILES.put(keys.page, new Uint8Array(1000));
  await env.FILES.put(keys.html, "<p>hi</p>");
  await env.FILES.put(keys.pdf, new Uint8Array(5000));
  await env.FILES.put(keys.version, "snapshot");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO texts (id, project_id, name, html_key, html_bytes, source_pdf_key, source_pdf_bytes, created_at, updated_at) VALUES (?1,?2,'T',?3,9,?4,5000,?5,?5)").bind(textId, projectId, keys.html, keys.pdf, now),
    env.DB.prepare("INSERT INTO pages (id, text_id, filename, image_key, image_bytes) VALUES (?1,?2,'p1.jpg',?3,1000)").bind(pageId, textId, keys.page),
    env.DB.prepare("INSERT INTO text_versions (id, text_id, content_type, r2_key, bytes, created_by, created_at) VALUES (?1,?2,'html',?3,8,?4,?5)").bind(versionId, textId, keys.version, authorSubject, now),
    env.DB.prepare("INSERT INTO metadata (text_id, dc_title, updated_at) VALUES (?1,'t',?2)").bind(textId, now),
    env.DB.prepare("INSERT INTO text_settings (text_id, model, updated_at) VALUES (?1,'m',?2)").bind(textId, now),
    env.DB.prepare("INSERT INTO annotations (id, text_id, author_subject, anchor_type, body, created_at, updated_at) VALUES (?1,?2,?3,'global','note',?4,?4)").bind(newId(), textId, authorSubject, now),
    env.DB.prepare("INSERT INTO text_fts (text_id, project_id, title, body) VALUES (?1,?2,'T','findable needle')").bind(textId, projectId),
    env.DB.prepare("INSERT INTO export_settings (project_id, settings_json, updated_at) VALUES (?1,'{}',?2) ON CONFLICT DO NOTHING").bind(projectId, now),
  ]);
  const owner = (await env.DB.prepare("SELECT owner_subject FROM projects WHERE id = ?").bind(projectId).first<{ owner_subject: string }>())!.owner_subject;
  // The rows above account for 6017 bytes; the counter says so (no reservation: the bytes are committed).
  await env.DB.prepare("UPDATE profiles SET storage_bytes = storage_bytes + 6017 WHERE subject = ?1").bind(owner).run();
  return { textId, keys };
}

const count = async (table: string, where = "1=1", ...binds: unknown[]) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...binds).first<{ n: number }>())!.n;
const r2Count = async (prefix = "") => (await env.FILES.list({ prefix })).objects.length;
const storage = async (s: string) => (await env.DB.prepare("SELECT storage_bytes FROM profiles WHERE subject = ?").bind(s).first<{ storage_bytes: number }>())!.storage_bytes;

describe("project deletion", () => {
  it("removes rows, FTS entries and R2 objects, and releases the owner's bytes", async () => {
    const id = await createProject(ALICE);
    const other = await createProject(ALICE, "Keep me");
    await seedContent(id, ALICE);
    await seedContent(other, ALICE);
    expect(await storage(ALICE)).toBe(12034);
    expect(await projectStorageBytes(env.DB, id)).toBe(6017);

    const res = await call(api(`/projects/${id}`), { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await count("texts", "project_id = ?", id)).toBe(0);
    expect(await count("pages")).toBe(1);
    expect(await count("text_versions")).toBe(1);
    expect(await count("annotations")).toBe(1);
    expect(await count("metadata")).toBe(1);
    expect(await count("text_fts")).toBe(1);
    expect(await count("export_settings", "project_id = ?", id)).toBe(0);
    expect(await r2Count(projectPrefix(id))).toBe(0);
    expect(await r2Count(projectPrefix(other))).toBe(4);
    expect(await storage(ALICE)).toBe(6017);
  });

  it("an R2 failure leaves a tombstone, and the cron finishes the sweep", async () => {
    const id = await createProject(ALICE);
    await seedContent(id, ALICE);
    const failing = await makeEnv({ FILES: { list: async () => { throw new Error("r2 down"); } } as unknown as R2Bucket });
    expect(await deleteProject(failing, id)).toBe(true);
    expect(await count("projects", "id = ?", id)).toBe(0);
    expect(await storage(ALICE)).toBe(0);
    expect(await count("r2_cleanup", "prefix = ? AND swept_at IS NULL", projectPrefix(id))).toBe(1);
    expect(await r2Count(projectPrefix(id))).toBe(4);
    expect(await processCleanup(await makeEnv())).toEqual({ swept: 1, failed: 0 });
    expect(await r2Count(projectPrefix(id))).toBe(0);
  });

  it("a second cron sweep removes an object an in-flight upload wrote after the first sweep, then forgets the tombstone", async () => {
    const id = await createProject(ALICE);
    await seedContent(id, ALICE);
    expect(await deleteProject(await makeEnv(), id)).toBe(true);
    // An upload that reserved and passed its checks before the delete finishes its R2 put afterwards.
    await env.FILES.put(`${projectPrefix(id)}t/late/page/late`, new Uint8Array(10));
    expect(await processCleanup(await makeEnv())).toEqual({ swept: 1, failed: 0 });
    expect(await r2Count(projectPrefix(id))).toBe(0);
    expect(await count("r2_cleanup")).toBe(1);
    await processCleanup(await makeEnv(), Date.now() + TOMBSTONE_KEEP_MS + 60_000);
    expect(await count("r2_cleanup")).toBe(0);
  });
});

describe("delete my data", () => {
  it("requires explicit confirmation", async () => {
    const res = await call(api("/me/data"), { method: "DELETE", body: {} });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("confirmation_required");
    expect((await call(api("/me/data"), { method: "DELETE", body: { confirm: "yes" } })).status).toBe(400);
  });

  it("cascades through everything the person owns and removes their R2 objects, leaving other people's data", async () => {
    const mine = await createProject(ALICE, "Mine");
    const mine2 = await createProject(ALICE, "Mine 2");
    const bobs = await createProject(BOB, "Bob's");
    const carols = await createProject(CAROL, "Carol's");
    await addMember(BOB, bobs, ALICE, "editor"); // Alice edits Bob's project
    await addMember(ALICE, mine, CAROL, "viewer"); // Carol views Alice's
    await call(api("/profile"), { method: "PUT", as: ALICE, body: { display_name: "Alice" } });
    await invite(ALICE, mine, "viewer");
    await seedContent(mine, ALICE);
    await seedContent(mine2, ALICE);
    const { textId: bobsText } = await seedContent(bobs, ALICE); // Alice authored a version + annotation in Bob's project
    await seedContent(carols, CAROL);
    await env.DB.prepare("INSERT INTO notifications (id, subject, type, title, created_at) VALUES (?1,?2,'t','t',?3)").bind(newId(), ALICE, nowIso()).run();
    await env.DB.prepare("INSERT INTO notification_preferences (subject) VALUES (?1)").bind(ALICE).run();
    expect(await storage(BOB)).toBe(6017);

    const res = await call(api("/me/data"), { method: "DELETE", body: { confirm: "delete my data" } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deleted: true, projects_deleted: 2 });

    // Alice's rows are gone everywhere.
    expect(await count("profiles", "subject = ?", ALICE)).toBe(0);
    expect(await count("projects", "owner_subject = ?", ALICE)).toBe(0);
    expect(await count("project_members", "subject = ?", ALICE)).toBe(0);
    expect(await count("annotations", "author_subject = ?", ALICE)).toBe(0);
    expect(await count("notifications", "subject = ?", ALICE)).toBe(0);
    expect(await count("notification_preferences", "subject = ?", ALICE)).toBe(0);
    expect(await count("invites", "created_by = ?", ALICE)).toBe(0);
    expect(await r2Count(projectPrefix(mine))).toBe(0);
    expect(await r2Count(projectPrefix(mine2))).toBe(0);

    // Other people's data is intact; what Alice only touched is kept, author cleared.
    expect(await r2Count(projectPrefix(bobs))).toBe(4);
    expect(await r2Count(projectPrefix(carols))).toBe(4);
    expect(await count("projects", "id IN (?, ?)", bobs, carols)).toBe(2);
    const version = await env.DB.prepare("SELECT created_by FROM text_versions WHERE text_id = ?").bind(bobsText).first<{ created_by: string | null }>();
    expect(version!.created_by).toBeNull();
    expect(await count("text_fts", "text_id = ?", bobsText)).toBe(1);
    expect(await storage(BOB)).toBe(6017);
    expect(await storage(CAROL)).toBe(6017);
    expect((await call(api(`/projects/${bobs}/members`), { as: BOB }).then(json)).members.map((m: any) => m.subject)).toEqual([BOB]);
    // Carol lost access to Alice's deleted project.
    expect((await call(api(`/projects/${mine}`), { as: CAROL })).status).toBe(404);
  });

  it("is re-runnable and leaves a fresh start on next sign-in", async () => {
    await createProject(ALICE);
    expect((await call(api("/me/data"), { method: "DELETE", body: { confirm: "delete my data" } })).status).toBe(200);
    expect((await call(api("/me/data"), { method: "DELETE", body: { confirm: "delete my data" } })).status).toBe(200);
    const session = await json(await call(api("/session")));
    expect(session.profile.display_name).toBeNull();
    expect((await json(await call(api("/projects")))).projects).toEqual([]);
  });

  it("the owner's removal also revokes redeemable links to the deleted project", async () => {
    const id = await createProject(ALICE);
    const inv = await invite(ALICE, id, "viewer");
    await call(api("/me/data"), { method: "DELETE", body: { confirm: "delete my data" } });
    expect((await redeem(BOB, inv.token)).status).toBe(404);
  });
});

describe("storage quota counter", () => {
  it("enforces the per-person quota atomically", async () => {
    const pid = await createProject(ALICE);
    const bobs = await createProject(BOB);
    const small = await makeEnv({ STORAGE_QUOTA_BYTES: "1000" });
    const first = await reserveStorage(small, pid, 600);
    await expect(reserveStorage(small, pid, 401)).rejects.toMatchObject({ code: "storage_quota_exceeded", status: 413 });
    const second = await reserveStorage(small, pid, 400);
    expect(await storage(ALICE)).toBe(1000);
    const concurrent = await Promise.allSettled([reserveStorage(small, bobs, 1), releaseReservation(env.DB, first)]);
    expect(concurrent[1]!.status).toBe("fulfilled");
    expect(await storage(ALICE)).toBe(400);
    // Released twice, or after the counter was corrected below it: never negative.
    await env.DB.prepare("UPDATE profiles SET storage_bytes = 100 WHERE subject = ?1").bind(ALICE).run();
    await releaseReservation(env.DB, second);
    await releaseReservation(env.DB, second);
    expect(await storage(ALICE)).toBe(0);
    // A project that no longer exists has no owner to reserve on.
    await expect(reserveStorage(small, crypto.randomUUID(), 1)).rejects.toMatchObject({ status: 404 });
  });

  it("racing reservations cannot jointly overshoot", async () => {
    const pid = await createProject(ALICE);
    const small = await makeEnv({ STORAGE_QUOTA_BYTES: "1000" });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserveStorage(small, pid, 300)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await storage(ALICE)).toBe(900);
  });

  it("default quota is 500 MB and configurable", async () => {
    expect((await json(await call(api("/session")))).storage.quota_bytes).toBe(524_288_000);
    const res = await call(api("/session"), { env: await makeEnv({ STORAGE_QUOTA_BYTES: "1048576", MAX_FILE_BYTES: "2048", MAX_PROJECT_PAGES: "7" }) });
    const body = await json(res);
    expect(body.storage.quota_bytes).toBe(1_048_576);
    expect(body.limits).toMatchObject({ max_file_bytes: 2048, max_project_pages: 7 });
  });
});

describe("retention", () => {
  const ageProject = (id: string, daysAgo: number) =>
    env.DB.prepare("UPDATE projects SET last_edited_at = ?1, retention_warned_at = NULL WHERE id = ?2").bind(addDays(nowIso(), -daysAgo), id).run();

  it("shows the deletion date and a warning flag in the project", async () => {
    const id = await createProject(ALICE);
    let p = (await json(await call(api(`/projects/${id}`)))).project;
    expect(p.retention).toMatchObject({ warning: false, days_remaining: 180 });
    await ageProject(id, 160);
    p = (await json(await call(api(`/projects/${id}`)))).project;
    expect(p.retention.warning).toBe(true);
    expect(p.retention.days_remaining).toBe(20);
  });

  it("warns first, deletes only after the warning has stood for a week", async () => {
    const id = await createProject(ALICE, "Old");
    await seedContent(id, ALICE);
    const fresh = await createProject(ALICE, "Fresh");
    await ageProject(id, 200);
    const e = await makeEnv();

    // Day 0 of the sweep: never warned, so warn, do NOT delete.
    expect(await runRetentionSweep(e)).toMatchObject({ warned: 1, deleted: 0, failed: 0, cleaned: 0 });
    expect(await count("projects", "id = ?", id)).toBe(1);
    const note = await env.DB.prepare("SELECT * FROM notifications WHERE subject = ?").bind(ALICE).first<any>();
    expect(note).toMatchObject({ type: "retention_warning", read: 0 });
    expect(note.body).toContain("Old");

    // Next day: warned only once, nothing else happens.
    expect(await runRetentionSweep(e, Date.now() + 86_400_000)).toMatchObject({ warned: 0, deleted: 0, failed: 0, cleaned: 0 });
    expect(await count("notifications")).toBe(1);

    // Eight days later: deleted, with objects and bytes.
    // The cleanup phase sweeps the new tombstone once more in the same run.
    expect(await runRetentionSweep(e, Date.now() + 8 * 86_400_000)).toMatchObject({ warned: 0, deleted: 1, failed: 0, cleaned: 1 });
    expect(await count("projects", "id = ?", id)).toBe(0);
    expect(await r2Count(projectPrefix(id))).toBe(0);
    expect(await storage(ALICE)).toBe(0);
    expect(await count("projects", "id = ?", fresh)).toBe(1);
  });

  it("an edit after the warning cancels deletion", async () => {
    const id = await createProject(ALICE);
    await ageProject(id, 170);
    const e = await makeEnv();
    expect((await runRetentionSweep(e)).warned).toBe(1);
    await call(api(`/projects/${id}`), { method: "PUT", body: { name: "Still here" } });
    const row = await env.DB.prepare("SELECT retention_warned_at FROM projects WHERE id = ?").bind(id).first<any>();
    expect(row.retention_warned_at).toBeNull();
    expect(await runRetentionSweep(e, Date.now() + 30 * 86_400_000)).toMatchObject({ deleted: 0 });
  });

  it("projects inside the warning window are warned, not deleted", async () => {
    const id = await createProject(ALICE);
    await ageProject(id, 175);
    expect(await runRetentionSweep(await makeEnv())).toMatchObject({ warned: 1, deleted: 0, failed: 0, cleaned: 0 });
  });

  // Regression: the sweep used to delete R2 objects first and never re-checked the row,
  // so an edit landing between the selection and the delete lost the project's files.
  it("an edit that lands after the sweep selected the project keeps the project and its files", async () => {
    const id = await createProject(ALICE, "Busy");
    await seedContent(id, ALICE);
    await env.DB.prepare("UPDATE projects SET last_edited_at = ?1, retention_warned_at = ?2 WHERE id = ?3").bind(addDays(nowIso(), -200), addDays(nowIso(), -20), id).run();
    const real = env.DB;
    const editingDb = new Proxy(real, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!/^SELECT id FROM projects WHERE last_edited_at < \?1 AND retention_warned_at IS NOT NULL/.test(sql.trim())) return statement;
            return {
              bind: (...args: unknown[]) => ({
                all: async () => {
                  const selected = await statement.bind(...args).all();
                  // Someone edits the project right after it was selected.
                  await target.prepare("UPDATE projects SET last_edited_at = ?1, retention_warned_at = NULL WHERE id = ?2").bind(nowIso(), id).run();
                  return selected;
                },
              }),
            };
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const result = await runRetentionSweep(await makeEnv({ DB: editingDb }));
    expect(result.deleted).toBe(0);
    expect(await count("projects", "id = ?", id)).toBe(1);
    expect(await r2Count(projectPrefix(id))).toBe(4);
    expect(await storage(ALICE)).toBe(6017);
  });

  it("warns every owner and editor (not viewers), once", async () => {
    const id = await createProject(ALICE, "Shared");
    await addMember(ALICE, id, BOB, "editor");
    await addMember(ALICE, id, CAROL, "viewer");
    await ageProject(id, 170);
    expect((await runRetentionSweep(await makeEnv())).warned).toBe(1);
    const notes = await env.DB.prepare("SELECT subject, id FROM notifications WHERE type = 'retention_warning' ORDER BY subject").all<{ subject: string; id: string }>();
    expect(notes.results.map((n) => n.subject).sort()).toEqual([ALICE, BOB].sort());
    for (const n of notes.results) expect(n.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await runRetentionSweep(await makeEnv())).warned).toBe(0);
    expect(await count("notifications", "type = 'retention_warning'")).toBe(2);
  });

  // Regression: the notification used to be inserted even when the compare-and-set stamp
  // missed because the project had just been edited.
  it("no warning is issued for a project edited between selection and stamping", async () => {
    const id = await createProject(ALICE, "Edited");
    await ageProject(id, 170);
    const real = env.DB;
    const editingDb = new Proxy(real, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target.prepare("UPDATE projects SET last_edited_at = ?1 WHERE id = ?2").bind(nowIso(), id).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    expect((await runRetentionSweep(await makeEnv({ DB: editingDb }))).warned).toBe(0);
    expect(await count("notifications")).toBe(0);
  });

  it("the scheduled handler runs the sweep", async () => {
    const id = await createProject(ALICE);
    await ageProject(id, 175);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    indexModule.scheduled!({ cron: "17 6 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, await makeEnv(), ctx);
    await Promise.all(pending);
    expect(await count("notifications", "type = 'retention_warning'")).toBe(1);
  });
});

describe("full-text search index", () => {
  it("is queryable, follows renames, and dies with its text and project", async () => {
    const id = await createProject(ALICE);
    const { textId } = await seedContent(id, ALICE);
    const hit = await env.DB.prepare("SELECT text_id FROM text_fts WHERE text_fts MATCH 'needle' AND project_id = ?").bind(id).all();
    expect(hit.results).toHaveLength(1);
    await env.DB.prepare("UPDATE texts SET name = 'Renamed chapter' WHERE id = ?").bind(textId).run();
    const byTitle = await env.DB.prepare("SELECT text_id FROM text_fts WHERE text_fts MATCH 'title:renamed'").all();
    expect(byTitle.results).toHaveLength(1);
    await env.DB.prepare("DELETE FROM texts WHERE id = ?").bind(textId).run();
    expect(await count("text_fts", "text_id = ?", textId)).toBe(0);
  });
});

describe("storage reservations and the recount", () => {
  it("a recount during an upload keeps its reservation; an abandoned one expires; genuine drift is fixed", async () => {
    const { ALICE, BOB, CAROL, JPEG, api, createProject, createText, storageOf, upload } = await import("./helpers");
    const { recountStorage, reserveStorage: reserve, RESERVATION_TTL_MS } = await import("../src/storage");
    const own: Record<string, string> = {};
    for (const who of [ALICE, BOB, CAROL]) {
      const p = await createProject(who, "Mine");
      own[who] = p;
      const t = await createText(who, p);
      await upload(api(`/texts/${t}/pages`), JPEG(300), who, { query: { filename: "a.jpg" } });
    }
    const truth = { alice: await storageOf(ALICE), bob: await storageOf(BOB), carol: await storageOf(CAROL) };
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_reservations").first<{ n: number }>()).toEqual({ n: 0 }); // committed uploads leave none
    // Bob has an upload in flight: its reservation is live.
    await reserve(await makeEnv(), own[BOB]!, 5000);
    // Carol's Worker died mid-upload an hour ago: an expired reservation.
    const stale = await reserve(await makeEnv(), own[CAROL]!, 4000);
    await env.DB.prepare("UPDATE storage_reservations SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?1").bind(stale!.id).run();
    // Alice's counter drifted with no reservation at all.
    await env.DB.prepare("UPDATE profiles SET storage_bytes = storage_bytes + 777 WHERE subject = ?1").bind(ALICE).run();
    expect(await recountStorage(await makeEnv())).toBeGreaterThanOrEqual(2);
    expect(await storageOf(ALICE)).toBe(truth.alice);
    expect(await storageOf(BOB)).toBe(truth.bob + 5000); // the upload in progress keeps its quota
    expect(await storageOf(CAROL)).toBe(truth.carol);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_reservations WHERE subject = ?1").bind(CAROL).first<{ n: number }>())!.n).toBe(0);
    expect(RESERVATION_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    // A recount right after changes nothing (the invariant holds).
    expect(await recountStorage(await makeEnv())).toBe(0);
  });

  it("a failed upload releases exactly its reservation; concurrent uploads at the quota edge cannot overshoot", async () => {
    const { ALICE, JPEG, api, createProject, createText, storageOf, upload } = await import("./helpers");
    const p = await createProject(ALICE, "Edge");
    const t = await createText(ALICE, p);
    const base = await storageOf(ALICE);
    const tight = await makeEnv({ STORAGE_QUOTA_BYTES: String(base + 1000) });
    // Declared 400 bytes, sent 10: size mismatch after the reservation, which is released.
    const short = await upload(api(`/texts/${t}/pages`), JPEG(10), ALICE, { query: { filename: "short.jpg", size: "400" }, env: tight });
    expect(short.status).toBe(400);
    expect(await storageOf(ALICE)).toBe(base);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => upload(api(`/texts/${t}/pages`), JPEG(300), ALICE, { query: { filename: `e${i}.jpg` }, env: tight })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(await storageOf(ALICE)).toBe(base + 900);
    expect(await storageOf(ALICE)).toBeLessThanOrEqual(base + 1000);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_reservations").first<{ n: number }>())!.n).toBe(0);
  });
});
