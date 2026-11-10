import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, addMember, api, call, createProject, createText, dbWithoutFts, json, makeEnv, seedPage, storageOf } from "./helpers";
import { CAPS, writeContent, type TextRow } from "../src/content";
import { projectStorageBytes } from "../src/storage";
import { projectPrefix } from "../src/r2-keys";

const put = (path: string, body: unknown, as = ALICE, method = "PUT") => call(api(path), { method, as, body });
const r2Keys = async (prefix = "") => (await env.FILES.list({ prefix })).objects.map((o) => o.key);
const textRow = async (id: string) => (await env.DB.prepare("SELECT * FROM texts WHERE id = ?").bind(id).first<TextRow>())!;
async function htmlProject() {
  const pid = await createProject(ALICE, "PDF", { project_type: "pdf_to_html" });
  const tid = await createText(ALICE, pid);
  return { pid, tid };
}
const versions = async (tid: string, type: string, as = ALICE) => (await json(await call(api(`/texts/${tid}/versions?type=${type}`), { as }))).versions as any[];

describe("texts", () => {
  it("create, list (paginated), rename, status, languages, delete", async () => {
    const pid = await createProject(ALICE);
    const ids = [await createText(ALICE, pid, "A"), await createText(ALICE, pid, "B"), await createText(ALICE, pid, "C")];
    const list = await json(await call(api(`/projects/${pid}/texts?limit=2&page=2`)));
    expect(list).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(list.texts.map((t: any) => t.name)).toEqual(["C"]);
    const upd = await put(`/texts/${ids[0]}`, { name: " Alpha ", status: "ocrd", source_language: "fr", target_language: "en", summary: "S" });
    expect((await json(upd)).text).toMatchObject({ name: "Alpha", status: "ocrd", source_language: "fr", summary: "S" });
    for (const bad of [{ name: "" }, { status: "nope" }, { source_language: "klingon" }, {}, { summary: 5 }]) expect((await put(`/texts/${ids[0]}`, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await put(`/texts/${ids[0]}`, { summary: "x".repeat(CAPS.summaryBytes + 1) })).status).toBe(413);
    expect((await call(api(`/texts/${ids[0]}`), { method: "DELETE" })).status).toBe(200);
    expect((await call(api(`/texts/${ids[0]}`))).status).toBe(404);
  });

  it("a text is only reachable through its own project's membership", async () => {
    const a = await createProject(ALICE), b = await createProject(BOB);
    const ta = await createText(ALICE, a);
    expect((await call(api(`/texts/${ta}`), { as: BOB })).status).toBe(404);
    const strange = await call(api("/texts/00000000-0000-4000-8000-000000000000"), { as: BOB });
    expect((await json(strange)).error.message).toBe((await json(await call(api(`/texts/${ta}`), { as: BOB }))).error.message);
    expect(b).toBeTruthy();
  });

  it("caps the number of texts per project", async () => {
    const pid = await createProject(ALICE);
    const now = new Date().toISOString();
    await env.DB.batch(Array.from({ length: CAPS.maxTextsPerProject }, (_, i) => env.DB.prepare("INSERT INTO texts (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), pid, `t${i}`, now, now)));
    const res = await call(api(`/projects/${pid}/texts`), { method: "POST", body: { name: "one too many" } });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("text_limit_reached");
  });

  it("reorder validates membership of ids", async () => {
    const pid = await createProject(ALICE), other = await createProject(ALICE, "Other");
    const [a, b] = [await createText(ALICE, pid, "a"), await createText(ALICE, pid, "b")];
    const foreign = await createText(ALICE, other);
    expect((await put(`/projects/${pid}/texts/reorder`, { textIds: [b, a] })).status).toBe(200);
    expect((await json(await call(api(`/projects/${pid}/texts`)))).texts.map((t: any) => t.name)).toEqual(["b", "a"]);
    expect((await put(`/projects/${pid}/texts/reorder`, { textIds: [a, foreign] })).status).toBe(400);
    expect((await put(`/projects/${pid}/texts/reorder`, { textIds: ["x"] })).status).toBe(400);
  });

  it("bulk operations are bounded and project-scoped", async () => {
    const pid = await createProject(ALICE), other = await createProject(ALICE, "Other");
    const mine = await createText(ALICE, pid), theirs = await createText(ALICE, other);
    const r = await put(`/projects/${pid}/texts/bulk-status`, { textIds: [mine, theirs], status: "reviewed" }, ALICE, "POST");
    expect((await json(r)).updated).toBe(1);
    expect((await textRow(theirs)).status).toBe("pending");
    expect((await put(`/projects/${pid}/texts/bulk-status`, { textIds: [mine], status: "bad" }, ALICE, "POST")).status).toBe(400);
    expect((await put(`/projects/${pid}/texts/bulk-delete`, { textIds: Array.from({ length: 51 }, () => crypto.randomUUID()) }, ALICE, "POST")).status).toBe(400);
    expect((await json(await put(`/projects/${pid}/texts/bulk-delete`, { textIds: [mine, theirs] }, ALICE, "POST"))).deleted).toBe(1);
    expect((await textRow(theirs)).id).toBe(theirs);
  });
});

describe("HTML content: sanitized on write, stored in R2, versioned, pruned", () => {
  it("sanitizes every write; D1 keeps only a pointer; stored bytes are the sanitized HTML", async () => {
    const { tid, pid } = await htmlProject();
    const res = await put(`/texts/${tid}/html`, { html_content: '<p onclick="x()">hi</p><script>alert(1)</script><a href="javascript:alert(1)">l</a>' });
    expect(await json(res)).toMatchObject({ ok: true, sanitized: true });
    const row = await textRow(tid);
    expect(row.html_key).toMatch(new RegExp(`^p/${pid}/t/${tid}/c/html/`));
    expect(await (await env.FILES.get(row.html_key!))!.text()).toBe("<p>hi</p><a>l</a>");
    expect(JSON.stringify({ ...row, search_text: null })).not.toContain("hi</p>");
    expect((await json(await call(api(`/texts/${tid}/html`)))).html_content).toBe("<p>hi</p><a>l</a>");
    expect(row.html_bytes).toBe(17);
  });

  it("stores TeX delimiters and MathML intact", async () => {
    const { tid } = await htmlProject();
    const html = '<p>\\(x^2\\)</p><math display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>';
    await put(`/texts/${tid}/html`, { html_content: html });
    expect((await json(await call(api(`/texts/${tid}/html`)))).html_content).toBe(html);
  });

  it("refuses over-long HTML instead of truncating it, and non-string input", async () => {
    const { tid } = await htmlProject();
    expect((await put(`/texts/${tid}/html`, { html_content: "x".repeat(CAPS.htmlInputChars + 1) })).status).toBe(413);
    expect((await put(`/texts/${tid}/html`, { html_content: 5 })).status).toBe(400);
    expect((await put(`/texts/${tid}/html`, {})).status).toBe(400);
    expect((await put(`/texts/${tid}/html`, { html_content: "<p>x</p>", pdf_meta: { a: "x".repeat(CAPS.pdfMetaBytes) } })).status).toBe(413);
    expect(await r2Keys()).toEqual([]);
  });

  it("is image-project vs pdf-project aware", async () => {
    const ip = await createProject(ALICE), it = await createText(ALICE, ip);
    const res = await put(`/texts/${it}/html`, { html_content: "<p>x</p>" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("wrong_project_type");
    const { tid } = await htmlProject();
    expect((await call(api(`/texts/${tid}/pages`))).status).toBe(400);
  });

  it("each overwrite snapshots the previous object as a version; counters stay equal to the rows", async () => {
    const { tid, pid } = await htmlProject();
    for (const html of ["<p>one</p>", "<p>twotwo</p>", "<p>three!</p>"]) await put(`/texts/${tid}/html`, { html_content: html });
    const vs = await versions(tid, "html");
    expect(vs).toHaveLength(2);
    const old = await json(await call(api(`/texts/${tid}/versions/${vs[vs.length - 1].id}`)));
    expect(old.version.content).toBe("<p>one</p>");
    expect(await r2Keys(projectPrefix(pid))).toHaveLength(3);
    expect(await storageOf(ALICE)).toBe(await projectStorageBytes(env.DB, pid));
    expect(await storageOf(ALICE)).toBe(10 + 13 + 13);
  });

  it("prunes to 50 versions per text+type, deleting objects and releasing bytes", async () => {
    const { tid, pid } = await htmlProject();
    for (let i = 0; i < 53; i += 1) await put(`/texts/${tid}/html`, { html_content: `<p>rev ${String(i).padStart(2, "0")}</p>` });
    expect(await versions(tid, "html")).toHaveLength(50);
    expect(await r2Keys(projectPrefix(pid))).toHaveLength(51);
    expect(await storageOf(ALICE)).toBe(51 * "<p>rev 00</p>".length);
    expect(await storageOf(ALICE)).toBe(await projectStorageBytes(env.DB, pid));
  }, 60_000);

  it("revert snapshots the CURRENT content first (legacy bug) and restores the old one", async () => {
    const { tid } = await htmlProject();
    await put(`/texts/${tid}/html`, { html_content: "<p>A</p>" });
    await put(`/texts/${tid}/html`, { html_content: "<p>B</p>" });
    const [vA] = await versions(tid, "html");
    expect((await call(api(`/texts/${tid}/versions/${vA.id}/revert`), { method: "POST" })).status).toBe(200);
    expect((await json(await call(api(`/texts/${tid}/html`)))).html_content).toBe("<p>A</p>");
    const contents: string[] = [];
    for (const v of await versions(tid, "html")) contents.push((await json(await call(api(`/texts/${tid}/versions/${v.id}`)))).version.content);
    expect(contents).toContain("<p>B</p>"); // the content that was current at revert time is recoverable
    expect(contents).toContain("<p>A</p>");
  });

  it("reverting a stored version re-sanitizes it", async () => {
    const { tid } = await htmlProject();
    await put(`/texts/${tid}/html`, { html_content: "<p>A</p>" });
    await put(`/texts/${tid}/html`, { html_content: "<p>B</p>" });
    const [v] = await versions(tid, "html");
    const key = (await env.DB.prepare("SELECT r2_key FROM text_versions WHERE id = ?").bind(v.id).first<{ r2_key: string }>())!.r2_key;
    await env.FILES.put(key, "<p>A</p><script>alert(1)</script>");
    await call(api(`/texts/${tid}/versions/${v.id}/revert`), { method: "POST" });
    expect((await json(await call(api(`/texts/${tid}/html`)))).html_content).toBe("<p>A</p>");
  });

  it("a stale concurrent writer gets 409 and leaves no orphan object or counter drift", async () => {
    const { tid, pid } = await htmlProject();
    await put(`/texts/${tid}/html`, { html_content: "<p>base</p>" });
    const stale = await textRow(tid);
    const e = await makeEnv();
    const project = (await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(pid).first<any>())!;
    await writeContent(e, project, stale, "html", "<p>winner</p>", ALICE);
    const before = await r2Keys(projectPrefix(pid));
    const bytes = await storageOf(ALICE);
    await expect(writeContent(e, project, stale, "html", "<p>loser!!</p>", BOB)).rejects.toMatchObject({ code: "edit_conflict", status: 409 });
    expect(await r2Keys(projectPrefix(pid))).toEqual(before);
    expect(await storageOf(ALICE)).toBe(bytes);
    expect(await versions(tid, "html")).toHaveLength(1);
  });

  it("an editor's write is charged to the owner and refused when the owner is out of quota", async () => {
    const { tid, pid } = await htmlProject();
    await addMember(ALICE, pid, BOB, "editor");
    expect((await put(`/texts/${tid}/html`, { html_content: "<p>edit</p>" }, BOB)).status).toBe(200);
    expect(await storageOf(ALICE)).toBe(11);
    expect(await storageOf(BOB)).toBe(0);
    const tiny = await makeEnv({ STORAGE_QUOTA_BYTES: "20" });
    const res = await call(api(`/texts/${tid}/html`), { method: "PUT", as: BOB, body: { html_content: "<p>" + "y".repeat(40) + "</p>" }, env: tiny });
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("storage_quota_exceeded");
    expect(await storageOf(ALICE)).toBe(11);
    expect(await r2Keys(projectPrefix(pid))).toHaveLength(1);
  });

  it("viewers cannot write", async () => {
    const { tid, pid } = await htmlProject();
    await addMember(ALICE, pid, CAROL, "viewer");
    expect((await put(`/texts/${tid}/html`, { html_content: "<p>x</p>" }, CAROL)).status).toBe(403);
  });
});

describe("compiled Markdown and page text", () => {
  it("compiled text lives in R2, is versioned, and capped", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    await put(`/texts/${tid}/save`, { text: "# one" }, ALICE, "POST");
    await put(`/texts/${tid}/save`, { text: "# two" }, ALICE, "POST");
    expect((await json(await call(api(`/texts/${tid}/compiled`)))).text).toBe("# two");
    expect(await versions(tid, "compiled")).toHaveLength(1);
    expect(JSON.stringify({ ...(await textRow(tid)), search_text: null })).not.toContain("# two");
    expect((await put(`/texts/${tid}/save`, { text: "x".repeat(CAPS.compiledBytes + 1) }, ALICE, "POST")).status).toBe(413);
    expect((await put(`/texts/${tid}/save`, {}, ALICE, "POST")).status).toBe(400);
  });

  it("page edits snapshot the old text; revert of a page snapshots the CURRENT text first (legacy bug)", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    const page = await seedPage(tid, { filename: "p.jpg", ocr: "v1", pageNumber: 1 });
    await put(`/texts/${tid}/pages/${page}`, { text: "v2" }, ALICE, "POST");
    await put(`/texts/${tid}/pages/${page}`, { text: "v3 corrected by a human" }, ALICE, "POST");
    const vs = await versions(tid, "page");
    expect(vs.map((v) => v.page_filename)).toEqual(["p.jpg", "p.jpg"]);
    const contents = await Promise.all(vs.map(async (v) => (await json(await call(api(`/texts/${tid}/versions/${v.id}`)))).version.content));
    expect(contents.sort()).toEqual(["v1", "v2"]);
    const v1 = vs[contents.indexOf("v1") === -1 ? 0 : (await Promise.all(vs.map(async (v, i) => [i, (await json(await call(api(`/texts/${tid}/versions/${v.id}`)))).version.content] as const))).find(([, c]) => c === "v1")![0]];
    expect((await call(api(`/texts/${tid}/versions/${v1!.id}/revert`), { method: "POST" })).status).toBe(200);
    expect((await json(await call(api(`/texts/${tid}`)))).pages[0].ocr_text).toBe("v1");
    const after = await Promise.all((await versions(tid, "page")).map(async (v) => (await json(await call(api(`/texts/${tid}/versions/${v.id}`)))).version.content));
    expect(after).toContain("v3 corrected by a human");
  });

  it("page text is capped and unchanged text creates no version", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    const page = await seedPage(tid, { ocr: "same" });
    expect((await put(`/texts/${tid}/pages/${page}`, { text: "x".repeat(CAPS.pageOcrBytes + 1) }, ALICE, "POST")).status).toBe(413);
    await put(`/texts/${tid}/pages/${page}`, { text: "same" }, ALICE, "POST");
    expect(await versions(tid, "page")).toHaveLength(0);
    expect((await put(`/texts/${tid}/pages/${page}`, { text: 5 }, ALICE, "POST")).status).toBe(400);
    expect((await put(`/texts/${tid}/pages/${crypto.randomUUID()}`, { text: "x" }, ALICE, "POST")).status).toBe(404);
  });

  it("page text may be written while empty (first OCR) without a version", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    const page = await seedPage(tid, { ocr: null });
    await put(`/texts/${tid}/pages/${page}`, { text: "first" }, ALICE, "POST");
    expect(await versions(tid, "page")).toHaveLength(0);
  });

  it("deleting a page removes its object and releases its bytes; reorder is exact", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    const a = await seedPage(tid, { filename: "a", imageBytes: 500, pageNumber: 1 });
    const b = await seedPage(tid, { filename: "b", imageBytes: 300, pageNumber: 2 });
    expect(await storageOf(ALICE)).toBe(800);
    expect((await put(`/texts/${tid}/pages/reorder`, { pageIds: [b] })).status).toBe(400);
    expect((await put(`/texts/${tid}/pages/reorder`, { pageIds: [b, a] })).status).toBe(200);
    expect((await json(await call(api(`/texts/${tid}/pages`)))).pages.map((p: any) => p.filename)).toEqual(["b", "a"]);
    expect((await call(api(`/texts/${tid}/pages/${a}`), { method: "DELETE" })).status).toBe(200);
    expect(await storageOf(ALICE)).toBe(300);
    expect(await r2Keys(projectPrefix(pid))).toHaveLength(1);
  });

  it("deleting a text frees objects, bytes, search row", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    await seedPage(tid, { imageBytes: 1000, ocr: "needle text" });
    await put(`/texts/${tid}/save`, { text: "# a" }, ALICE, "POST");
    await put(`/texts/${tid}/save`, { text: "# bb" }, ALICE, "POST");
    expect(await storageOf(ALICE)).toBeGreaterThan(1000);
    await call(api(`/texts/${tid}`), { method: "DELETE" });
    expect(await storageOf(ALICE)).toBe(0);
    expect(await r2Keys(projectPrefix(pid))).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM text_fts").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM text_versions").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("metadata and settings", () => {
  it("metadata upserts only Dublin Core fields and validates length", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    const r = await put(`/texts/${tid}/metadata`, { dc_title: "Title", dc_creator: "A", text_id: "evil", extra: "x" }, ALICE, "POST");
    expect((await json(r)).metadata).toMatchObject({ dc_title: "Title", dc_creator: "A", text_id: tid });
    await put(`/texts/${tid}/metadata`, { dc_title: "Second" }, ALICE, "POST");
    expect((await json(await call(api(`/texts/${tid}/metadata`)))).metadata).toMatchObject({ dc_title: "Second", dc_creator: null });
    expect((await put(`/texts/${tid}/metadata`, { dc_title: "x".repeat(2001) }, ALICE, "POST")).status).toBe(400);
    expect((await put(`/texts/${tid}/metadata`, { dc_title: 5 }, ALICE, "POST")).status).toBe(400);
  });

  it("settings validate, merge and clear", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    await put(`/texts/${tid}/settings`, { model: "qwen3-vl-235b-a22b-instruct", temperature: 0.3, max_tokens: 2000, prompt: "p" }, ALICE, "POST");
    const r = await put(`/texts/${tid}/settings`, { math_model: "some-model" }, ALICE, "POST");
    expect((await json(r)).settings).toMatchObject({ model: "qwen3-vl-235b-a22b-instruct", math_model: "some-model", temperature: 0.3, max_tokens: 2000 });
    for (const bad of [{ model: "bad model!" }, { temperature: 2 }, { max_tokens: 99999 }, { max_tokens: 1.5 }, { prompt: "x".repeat(3001) }, { model: 5 }]) {
      expect((await put(`/texts/${tid}/settings`, bad, ALICE, "POST")).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(api(`/texts/${tid}/settings`), { method: "DELETE" })).status).toBe(200);
    expect((await json(await call(api(`/texts/${tid}/settings`)))).settings).toEqual({});
  });
});

describe("search", () => {
  async function corpus() {
    const pa = await createProject(ALICE, "Alice papers"), pb = await createProject(BOB, "Bob secrets");
    const ta = await createText(ALICE, pa, "Letters"), tb = await createText(BOB, pb, "Private");
    const pg = await seedPage(ta, { ocr: "The quick brownfox jumps. Total 100% effort." });
    await put(`/texts/${ta}/pages/${pg}`, { text: "The quick brownfox jumps. Total 100% effort." }, ALICE, "POST");
    const pgb = await seedPage(tb, { ocr: "brownfox in Bob's private text" });
    await put(`/texts/${tb}/pages/${pgb}`, { text: "brownfox in Bob's private text" }, BOB, "POST");
    return { pa, pb, ta, tb };
  }

  it("finds text through FTS5 and only inside the caller's projects", async () => {
    const { ta, tb } = await corpus();
    const mine = await json(await call(api("/search?q=brownfox")));
    expect(mine.backend).toBe("fts5");
    expect(mine.results.map((r: any) => r.text_id)).toEqual([ta]);
    expect(mine.results[0]).toMatchObject({ project_name: "Alice papers", access_role: "owner" });
    expect(mine.results[0].snippet).toContain("brownfox");
    expect((await json(await call(api("/search?q=brownfox"), { as: BOB }))).results.map((r: any) => r.text_id)).toEqual([tb]);
    expect((await json(await call(api("/search?q=brownfox"), { as: CAROL }))).results).toEqual([]);
  });

  it("shared projects become searchable to the invited member; leaving removes them", async () => {
    const { pa, ta } = await corpus();
    await addMember(ALICE, pa, CAROL, "viewer");
    expect((await json(await call(api("/search?q=brownfox"), { as: CAROL }))).results.map((r: any) => r.text_id)).toEqual([ta]);
    await call(api(`/projects/${pa}/members/${CAROL}`), { method: "DELETE", as: CAROL });
    expect((await json(await call(api("/search?q=brownfox"), { as: CAROL }))).results).toEqual([]);
  });

  it("indexes extracted plain text, never HTML markup, and follows renames", async () => {
    const { tid } = await htmlProject();
    await put(`/texts/${tid}/html`, { html_content: '<h1>Gamma ray</h1><p class="zzclass">burst <math><mi>x</mi></math></p><script>hiddenpayload()</script>' });
    expect((await json(await call(api("/search?q=gamma")))).results).toHaveLength(1);
    expect((await json(await call(api("/search?q=zzclass")))).results).toHaveLength(0);
    expect((await json(await call(api("/search?q=hiddenpayload")))).results).toHaveLength(0);
    await put(`/texts/${tid}`, { name: "Renamed spectroscopy" });
    expect((await json(await call(api("/search?q=spectroscopy")))).results).toHaveLength(1);
  });

  it("degrades to a plain-text LIKE search when FTS is unavailable (same scoping, wildcards escaped)", async () => {
    const { ta, tb } = await corpus();
    const noFts = await makeEnv({ DB: dbWithoutFts(env.DB) });
    const res = await json(await call(api("/search?q=brownfox"), { env: noFts }));
    expect(res.backend).toBe("like");
    expect(res.results.map((r: any) => r.text_id)).toEqual([ta]);
    expect((await json(await call(api("/search?q=brownfox"), { as: BOB, env: noFts }))).results.map((r: any) => r.text_id)).toEqual([tb]);
    expect((await json(await call(api("/search?q=100%25%20eff"), { env: noFts }))).results).toHaveLength(1);
    expect((await json(await call(api("/search?q=%25%25"), { env: noFts }))).results).toHaveLength(0);
  });

  it("writes still succeed when the FTS table is missing", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    const noFts = await makeEnv({ DB: dbWithoutFts(env.DB) });
    const pg = await seedPage(tid, { ocr: "old" });
    expect((await call(api(`/texts/${tid}/pages/${pg}`), { method: "POST", body: { text: "survives without fts" }, env: noFts })).status).toBe(200);
    expect((await textRow(tid)).search_text).toContain("survives without fts");
  });

  it("validates the query", async () => {
    for (const q of ["", "a", "x".repeat(201)]) expect((await call(api(`/search?q=${q}`))).status).toBe(400);
    expect((await call(api("/search?q=%22%20OR%20%22*"))).status).toBe(200); // FTS syntax characters are neutralised
  });
});

describe("split and merge", () => {
  it("split copies pages and images, reserves quota, and keeps status", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid, "Book");
    await seedPage(tid, { filename: "1.jpg", ocr: "one", imageBytes: 100, pageNumber: 1 });
    await seedPage(tid, { filename: "2.jpg", ocr: "two", imageBytes: 200, pageNumber: 2 });
    await seedPage(tid, { filename: "3.jpg", ocr: "three", imageBytes: 300, pageNumber: 3 });
    const res = await put(`/texts/${tid}/split`, { splits: [{ name: "Part 1", pages: [1, 2] }, { name: "Part 2", pages: [3] }] }, ALICE, "POST");
    expect(res.status).toBe(201);
    const { texts } = await json(res);
    expect(texts).toHaveLength(2);
    const p1 = (await json(await call(api(`/texts/${texts[0].id}`)))).pages;
    expect(p1.map((p: any) => [p.page_number, p.ocr_text])).toEqual([[1, "one"], [2, "two"]]);
    expect(await storageOf(ALICE)).toBe(1200);
    expect(await projectStorageBytes(env.DB, pid)).toBe(1200);
    expect((await r2Keys(projectPrefix(pid))).length).toBe(6);
  });

  it("split over quota is refused atomically and leaves nothing behind", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    await seedPage(tid, { filename: "1.jpg", imageBytes: 600, pageNumber: 1 });
    const tiny = await makeEnv({ STORAGE_QUOTA_BYTES: "1000" });
    const res = await call(api(`/texts/${tid}/split`), { method: "POST", env: tiny, body: { splits: [{ name: "A", pages: [1] }, { name: "B", pages: [1] }] } });
    expect(res.status).toBe(413);
    expect(await storageOf(ALICE)).toBe(600);
    expect((await json(await call(api(`/projects/${pid}/texts`)))).total).toBe(1);
    expect(await r2Keys(projectPrefix(pid))).toHaveLength(1);
  });

  it("split validates its input and the project page cap", async () => {
    const pid = await createProject(ALICE), tid = await createText(ALICE, pid);
    for (const bad of [{}, { splits: [{ name: "A", pages: [1] }] }, { splits: [{ name: "", pages: [1] }, { name: "B", pages: [1] }] }, { splits: [{ name: "A", pages: ["x"] }, { name: "B", pages: [1] }] }]) {
      expect((await put(`/texts/${tid}/split`, bad, ALICE, "POST")).status, JSON.stringify(bad)).toBe(400);
    }
    await seedPage(tid, { filename: "1.jpg", ocr: "x", pageNumber: 1 });
    const small = await makeEnv({ MAX_PROJECT_PAGES: "2" });
    const res = await call(api(`/texts/${tid}/split`), { method: "POST", env: small, body: { splits: [{ name: "A", pages: [1] }, { name: "B", pages: [1] }] } });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("page_limit_reached");
  });

  it("merge combines pages in the given order with collision-free names", async () => {
    const pid = await createProject(ALICE);
    const a = await createText(ALICE, pid, "A"), b = await createText(ALICE, pid, "B");
    await seedPage(a, { filename: "1.jpg", ocr: "a1", imageBytes: 10, pageNumber: 1 });
    await seedPage(b, { filename: "1.jpg", ocr: "b1", imageBytes: 20, pageNumber: 1 });
    const res = await put(`/projects/${pid}/texts/merge`, { textIds: [b, a], name: "Both" }, ALICE, "POST");
    expect(res.status).toBe(201);
    const merged = (await json(res)).text.id;
    const pages = (await json(await call(api(`/texts/${merged}`)))).pages;
    expect(pages.map((p: any) => [p.filename, p.ocr_text, p.page_number])).toEqual([["t1_1.jpg", "b1", 1], ["t2_1.jpg", "a1", 2]]);
    expect(await storageOf(ALICE)).toBe(60);
    expect((await put(`/projects/${pid}/texts/merge`, { textIds: [a], name: "x" }, ALICE, "POST")).status).toBe(400);
    expect((await put(`/projects/${pid}/texts/merge`, { textIds: [a, crypto.randomUUID()], name: "x" }, ALICE, "POST")).status).toBe(400);
  });
});
