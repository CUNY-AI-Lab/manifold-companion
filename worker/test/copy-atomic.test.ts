// Split and merge write every new text and page in one transaction, or none.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, api, call, createProject, createText, json, makeEnv, objectDrift, seedPage, storageDrift } from "./helpers";

/**
 * A D1 binding that lets a test act just before the copy's batch (after its
 * cap pre-checks and its reservation) and makes the row-by-row cleanup fail,
 * as an interrupted Worker would leave it.
 */
function racingDb(real: D1Database, beforeBatch: () => Promise<void>): D1Database {
  let fired = false;
  return {
    prepare: (sql: string) => {
      if (sql === "DELETE FROM texts WHERE id = ?1") {
        const failing = { bind: () => failing, run: async () => { throw new Error("worker interrupted"); } };
        return failing as unknown as D1PreparedStatement;
      }
      return real.prepare(sql);
    },
    batch: async (s: D1PreparedStatement[]) => {
      if (!fired && s.length > 3) {
        fired = true;
        await beforeBatch();
      }
      return real.batch(s);
    },
    exec: (s: string) => real.exec(s),
  } as unknown as D1Database;
}

describe("split and merge are all or nothing", () => {
  it("a copy refused part-way by a racing cap leaves no rows, no objects and no unpaid bytes", async () => {
    const pid = await createProject(ALICE);
    const src = await createText(ALICE, pid, "Source");
    for (let n = 1; n <= 4; n += 1) await seedPage(src, { filename: `${n}.jpg`, ocr: `page ${n}`, imageBytes: 500, pageNumber: n });
    const other = await createText(ALICE, pid, "Other");
    // Room for exactly the 4 copies when the request checks; a racing upload takes 2 of it before the batch.
    const e = await makeEnv({ MAX_PROJECT_PAGES: "8" });
    e.DB = racingDb(env.DB, async () => {
      await seedPage(other, { filename: "x.jpg", pageNumber: 1 });
      await seedPage(other, { filename: "y.jpg", pageNumber: 2 });
    });
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM texts WHERE project_id = ?1").bind(pid).first<{ n: number }>())!.n;
    const res = await call(api(`/texts/${src}/split`), { method: "POST", env: e, body: { splits: [{ name: "A", pages: [1, 2] }, { name: "B", pages: [3, 4] }] } });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("page_limit_reached");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM texts WHERE project_id = ?1").bind(pid).first<{ n: number }>())!.n).toBe(before);
    expect(await storageDrift()).toEqual([]);
    expect(await objectDrift()).toEqual({ dangling: [], orphans: [] });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_reservations").first()).toEqual({ n: 0 });
  });

  it("a merge refused by a racing text cap reports the text limit", async () => {
    const pid = await createProject(ALICE);
    const a = await createText(ALICE, pid, "A");
    const b = await createText(ALICE, pid, "B");
    await seedPage(a, { filename: "1.jpg", ocr: "a", imageBytes: 100, pageNumber: 1 });
    await seedPage(b, { filename: "1.jpg", ocr: "b", imageBytes: 100, pageNumber: 1 });
    const e = await makeEnv({ MAX_TEXTS_PER_PROJECT: "3" });
    e.DB = racingDb(env.DB, async () => { await createText(ALICE, pid, "Racer"); });
    const res = await call(api(`/projects/${pid}/texts/merge`), { method: "POST", env: e, body: { textIds: [a, b], name: "Merged" } });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("text_limit_reached");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM texts WHERE project_id = ?1").bind(pid).first<{ n: number }>())!.n).toBe(3);
    expect(await storageDrift()).toEqual([]);
    expect(await objectDrift()).toEqual({ dangling: [], orphans: [] });
  });
});
