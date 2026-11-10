// Check-then-act hazards: every cap must hold, and every byte of quota must be
// released exactly once, under concurrent requests.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, JPEG, PDF, PNG, api, call, createProject, createText, json, makeEnv, seedPage, storageOf, upload } from "./helpers";
import { pruneVersions } from "../src/content";
import { projectPrefix } from "../src/r2-keys";
import { projectStorageBytes } from "../src/storage";

const r2Count = async (prefix = "") => (await env.FILES.list({ prefix })).objects.length;
const statuses = (rs: Response[]) => rs.map((r) => r.status).sort((a, b) => a - b);
async function pdfText() {
  const pid = await createProject(ALICE, "P", { project_type: "pdf_to_html" });
  return { pid, tid: await createText(ALICE, pid) };
}

describe("quota is released exactly once per removed row", () => {
  it("concurrent deletes of the same figure", async () => {
    const { tid, pid } = await pdfText();
    const a = (await json(await upload(api(`/texts/${tid}/figures`), PNG(100), ALICE, { query: { filename: "a.png" } }))).figure.id;
    await upload(api(`/texts/${tid}/figures`), PNG(300), ALICE, { query: { filename: "b.png" } });
    expect(await storageOf(ALICE)).toBe(400);
    const rs = await Promise.all([1, 2, 3].map(() => call(api(`/texts/${tid}/figures/${a}`), { method: "DELETE" })));
    expect(statuses(rs)).toEqual([200, 404, 404]);
    expect(await storageOf(ALICE)).toBe(300);
    expect(await projectStorageBytes(env.DB, pid)).toBe(300);
  });

  it("concurrent deletes of the same page", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    const p1 = await seedPage(tid, { filename: "1", imageBytes: 100, pageNumber: 1 });
    await seedPage(tid, { filename: "2", imageBytes: 300, pageNumber: 2 });
    const rs = await Promise.all([1, 2, 3].map(() => call(api(`/texts/${tid}/pages/${p1}`), { method: "DELETE" })));
    expect(statuses(rs)).toEqual([200, 404, 404]);
    expect(await storageOf(ALICE)).toBe(300);
  });

  it("concurrent deletes of the same text", async () => {
    const pid = await createProject(ALICE);
    const t1 = await createText(ALICE, pid, "one"), t2 = await createText(ALICE, pid, "two");
    await seedPage(t1, { imageBytes: 100 });
    await seedPage(t2, { imageBytes: 300 });
    const rs = await Promise.all([1, 2, 3].map(() => call(api(`/texts/${t1}`), { method: "DELETE" })));
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await storageOf(ALICE)).toBe(300);
    const bulk = await Promise.all([1, 2].map(() => call(api(`/projects/${pid}/texts/bulk-delete`), { method: "POST", body: { textIds: [t2] } })));
    expect(bulk.every((r) => r.status === 200)).toBe(true);
    expect(await storageOf(ALICE)).toBe(0);
  });

  it("concurrent deletes of the same project", async () => {
    const p1 = await createProject(ALICE, "one"), p2 = await createProject(ALICE, "two");
    await seedPage(await createText(ALICE, p1), { imageBytes: 100 });
    await seedPage(await createText(ALICE, p2), { imageBytes: 300 });
    const rs = await Promise.all([1, 2, 3].map(() => call(api(`/projects/${p1}`), { method: "DELETE" })));
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await storageOf(ALICE)).toBe(300);
    expect(await r2Count(projectPrefix(p2))).toBe(1);
  });

  it("a delete racing an upload into the same text never over-releases", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    const other = await createText(ALICE, pid, "keep");
    await seedPage(other, { imageBytes: 500 });
    await seedPage(tid, { imageBytes: 100, filename: "old.jpg" });
    await Promise.all([call(api(`/texts/${tid}`), { method: "DELETE" }), upload(api(`/texts/${tid}/pages`), JPEG(200), ALICE, { query: { filename: "new.jpg" } })]);
    // whatever the interleaving, the counter equals what the rows account for
    expect(await storageOf(ALICE)).toBe(await projectStorageBytes(env.DB, pid));
  });

  it("concurrent version pruning releases each pruned version once", async () => {
    const pid = await createProject(ALICE, "P", { project_type: "pdf_to_html" }), tid = await createText(ALICE, pid);
    const keep = await createText(ALICE, pid, "keep");
    await seedPage(keep, { imageBytes: 1000 });
    const now = new Date().toISOString();
    const rows: D1PreparedStatement[] = [];
    for (let i = 0; i < 56; i += 1) {
      const key = `p/${pid}/t/${tid}/c/html/${crypto.randomUUID()}`;
      await env.FILES.put(key, "x".repeat(10));
      rows.push(env.DB.prepare("INSERT INTO text_versions (id, text_id, content_type, r2_key, bytes, created_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), tid, "html", key, 10, new Date(Date.parse(now) + i * 1000).toISOString()));
    }
    await env.DB.batch(rows);
    await env.DB.prepare("UPDATE profiles SET storage_bytes = storage_bytes + 560 WHERE subject = ?").bind(ALICE).run();
    const project = (await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first<any>())!;
    const e = await makeEnv();
    await Promise.all([pruneVersions(e, project, tid, "html"), pruneVersions(e, project, tid, "html"), pruneVersions(e, project, tid, "html")]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM text_versions WHERE text_id = ?").bind(tid).first<{ n: number }>())!.n).toBe(50);
    expect(await storageOf(ALICE)).toBe(1000 + 500);
  });
});

describe("caps hold under concurrency (conditional inserts, not check-then-insert)", () => {
  it("figures per text", async () => {
    const { tid, pid } = await pdfText();
    const cap = await makeEnv({ MAX_FIGURES_PER_TEXT: "2" });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => upload(api(`/texts/${tid}/figures`), PNG(50), ALICE, { query: { filename: `f${i}.png` }, env: cap })));
    expect(statuses(rs)).toEqual([201, 201, 409, 409, 409, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM figures WHERE text_id = ?").bind(tid).first<{ n: number }>())!.n).toBe(2);
    expect(await r2Count(projectPrefix(pid))).toBe(2);
    expect(await storageOf(ALICE)).toBe(100);
    const refused = rs.find((r) => r.status === 409)!;
    expect((await json(refused)).error.code).toBe("figure_limit_reached");
  });

  it("texts per project", async () => {
    const pid = await createProject(ALICE);
    const cap = await makeEnv({ MAX_TEXTS_PER_PROJECT: "2" });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => call(api(`/projects/${pid}/texts`), { method: "POST", body: { name: `t${i}` }, env: cap })));
    expect(statuses(rs)).toEqual([201, 201, 409, 409, 409, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM texts WHERE project_id = ?").bind(pid).first<{ n: number }>())!.n).toBe(2);
    const orders = (await env.DB.prepare("SELECT sort_order FROM texts WHERE project_id = ? ORDER BY sort_order").bind(pid).all<{ sort_order: number }>()).results.map((r) => r.sort_order);
    expect(new Set(orders).size).toBe(2);
  });

  it("projects per person (the owner row is created only with its project)", async () => {
    const cap = await makeEnv({ MAX_PROJECTS_PER_PERSON: "2" });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => call(api("/projects"), { method: "POST", body: { name: `p${i}` }, env: cap })));
    expect(statuses(rs)).toEqual([201, 201, 409, 409, 409, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>())!.n).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_members").first<{ n: number }>())!.n).toBe(2);
    expect((await json(rs.find((r) => r.status === 409)!)).error.code).toBe("project_limit_reached");
  });

  it("active invites per project", async () => {
    const pid = await createProject(ALICE);
    const cap = await makeEnv({ MAX_ACTIVE_INVITES: "2" });
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(api(`/projects/${pid}/invites`), { method: "POST", body: { role: "viewer" }, env: cap })));
    expect(statuses(rs)).toEqual([201, 201, 409, 409, 409, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE project_id = ?").bind(pid).first<{ n: number }>())!.n).toBe(2);
  });

  it("pages per project across concurrent splits and merges", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    await seedPage(tid, { filename: "1", ocr: "a", imageBytes: 10, pageNumber: 1 });
    await seedPage(tid, { filename: "2", ocr: "b", imageBytes: 10, pageNumber: 2 });
    const cap = await makeEnv({ MAX_PROJECT_PAGES: "4" });
    const split = () => call(api(`/texts/${tid}/split`), { method: "POST", env: cap, body: { splits: [{ name: "A", pages: [1] }, { name: "B", pages: [2] }] } });
    const rs = await Promise.all([split(), split(), split()]);
    expect(statuses(rs)).toEqual([201, 409, 409]);
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM pages p JOIN texts t ON t.id = p.text_id WHERE t.project_id = ?").bind(pid).first<{ n: number }>())!.n;
    expect(n).toBe(4);
    expect(await storageOf(ALICE)).toBe(await projectStorageBytes(env.DB, pid));
    expect(await r2Count(projectPrefix(pid))).toBe(4);
  });

  it("texts per project across concurrent splits", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    await seedPage(tid, { filename: "1", ocr: "a", pageNumber: 1 });
    const cap = await makeEnv({ MAX_TEXTS_PER_PROJECT: "3" });
    const split = () => call(api(`/texts/${tid}/split`), { method: "POST", env: cap, body: { splits: [{ name: "A", pages: [1] }, { name: "B", pages: [1] }] } });
    const rs = await Promise.all([split(), split(), split()]);
    expect(statuses(rs)).toEqual([201, 409, 409]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM texts WHERE project_id = ?").bind(pid).first<{ n: number }>())!.n).toBe(3);
    expect((await json(rs.find((r) => r.status === 409)!)).error.code).toBe("text_limit_reached");
  });

  it("the source PDF cannot be created twice at once", async () => {
    const { tid, pid } = await pdfText();
    const rs = await Promise.all([1, 2, 3].map((i) => upload(api(`/texts/${tid}/source-pdf`), PDF(100 + i), ALICE, { method: "PUT", query: { filename: `s${i}.pdf` } })));
    expect(statuses(rs)).toEqual([201, 409, 409]);
    expect(await r2Count(projectPrefix(pid))).toBe(1);
    expect(await storageOf(ALICE)).toBe(await projectStorageBytes(env.DB, pid));
  });
});
