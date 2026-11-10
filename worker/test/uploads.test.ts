import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, JPEG, PDF, PNG, WEBP, addMember, api, call, createProject, createText, json, legs, makeEnv, ORIGIN, storageOf, upload } from "./helpers";
import { projectStorageBytes } from "../src/storage";
import { projectPrefix } from "../src/r2-keys";
import app from "../src/app";
import { cleanFilename, sniffImage } from "../src/uploads";

const r2Keys = async (prefix = "") => (await env.FILES.list({ prefix })).objects.map((o) => o.key);
async function imageText() {
  const pid = await createProject(ALICE);
  return { pid, tid: await createText(ALICE, pid) };
}
async function pdfText() {
  const pid = await createProject(ALICE, "P", { project_type: "pdf_to_html" });
  return { pid, tid: await createText(ALICE, pid) };
}
const pageUrl = (tid: string) => api(`/texts/${tid}/pages`);
const up = (tid: string, bytes: Uint8Array, filename = "a.jpg", as = ALICE, env?: Awaited<ReturnType<typeof makeEnv>>) => upload(pageUrl(tid), bytes, as, { query: { filename }, ...(env ? { env } : {}) });

describe("page image upload", () => {
  it("stores the bytes in R2, the row in D1, and charges the owner", async () => {
    const { pid, tid } = await imageText();
    const res = await up(tid, JPEG(1000), "scan 1.jpg");
    expect(res.status).toBe(201);
    const { page } = await json(res);
    expect(page).toMatchObject({ filename: "scan 1.jpg", page_number: 1, image_bytes: 1000, image_type: "image/jpeg" });
    expect(await storageOf(ALICE)).toBe(1000);
    expect(await r2Keys(projectPrefix(pid))).toEqual([expect.stringMatching(new RegExp(`^p/${pid}/t/${tid}/page/`))]);
    expect((await json(await up(tid, PNG(10), "b.png"))).page.page_number).toBe(2);
    expect((await json(await up(tid, WEBP(20), "c.webp"))).page.image_type).toBe("image/webp");
    expect(await storageOf(ALICE)).toBe(1030);
    expect(await projectStorageBytes(env.DB, pid)).toBe(1030);
  });

  it("serves it back with an explicit type, nosniff, a sandbox CSP and authorization on every read", async () => {
    const { tid } = await imageText();
    const { page } = await json(await up(tid, PNG(50), "x.png"));
    const ok = await call(api(`/texts/${tid}/pages/${page.id}/image`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-security-policy")).toMatch(/^sandbox/);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect((await ok.arrayBuffer()).byteLength).toBe(50);
    expect((await call(api(`/texts/${tid}/pages/${page.id}/image`), { as: BOB })).status).toBe(404);
    expect((await call(api(`/texts/${tid}/pages/${page.id}/image`), { as: null })).status).toBe(401);
    expect((await call(api(`/texts/${tid}/pages/${crypto.randomUUID()}/image`))).status).toBe(404);
  });

  it("an editor's upload is charged to the owner; a viewer cannot upload", async () => {
    const { pid, tid } = await imageText();
    await addMember(ALICE, pid, BOB, "editor");
    await addMember(ALICE, pid, CAROL, "viewer");
    expect((await up(tid, JPEG(100), "e.jpg", BOB)).status).toBe(201);
    expect(await storageOf(ALICE)).toBe(100);
    expect(await storageOf(BOB)).toBe(0);
    expect((await up(tid, JPEG(100), "v.jpg", CAROL)).status).toBe(403);
    expect(await storageOf(ALICE)).toBe(100);
  });

  it("magic-byte checks decide the type, not the file name or headers", async () => {
    const { pid, tid } = await imageText();
    for (const [name, bytes] of [["a.jpg", new TextEncoder().encode("<html><script>alert(1)</script></html>")], ["b.png", PDF()], ["c.jpg", new Uint8Array(100)], ["d.svg", new TextEncoder().encode("<svg onload=alert(1)/>")], ["e.jpg", new Uint8Array([0xff, 0xd8])]] as const) {
      const res = await up(tid, bytes as Uint8Array, name);
      expect(res.status, name).toBe(415);
      expect((await json(res)).error.code).toBe("unsupported_media_type");
    }
    expect(await storageOf(ALICE)).toBe(0);
    expect(await r2Keys(projectPrefix(pid))).toEqual([]);
    // a PNG named .jpg is stored and served as PNG
    const { page } = await json(await up(tid, PNG(30), "liar.jpg"));
    expect((await call(api(`/texts/${tid}/pages/${page.id}/image`))).headers.get("content-type")).toBe("image/png");
  });

  it("requires a declared size and enforces it exactly", async () => {
    const { tid } = await imageText();
    const noSize = await call(`${pageUrl(tid)}?filename=a.jpg`, { method: "POST", body: JPEG(10) });
    expect((await json(noSize)).error.code).toBe("size_required");
    expect((await call(`${pageUrl(tid)}?filename=a.jpg&size=abc`, { method: "POST", body: JPEG(10) })).status).toBe(400);
    expect((await call(`${pageUrl(tid)}?filename=a.jpg&size=0`, { method: "POST", body: JPEG(10) })).status).toBe(400);
    const over = await call(`${pageUrl(tid)}?filename=a.jpg&size=10`, { method: "POST", body: JPEG(50) });
    expect(over.status).toBe(413);
    const under = await call(`${pageUrl(tid)}?filename=a.jpg&size=50`, { method: "POST", body: JPEG(10) });
    expect((await json(under)).error.code).toBe("size_mismatch");
    expect(await storageOf(ALICE)).toBe(0);
    expect(await r2Keys()).toEqual([]);
  });

  it("enforces the per-file cap before reserving anything or reading the body", async () => {
    const { tid } = await imageText();
    const small = await makeEnv({ MAX_FILE_BYTES: "100" });
    let pulled = false;
    const body = new ReadableStream({ pull(c) { pulled = true; c.enqueue(JPEG(101)); c.close(); } }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}${pageUrl(tid)}?filename=a.jpg&size=101`, { method: "POST", headers: { ...(await legs(ALICE)), origin: ORIGIN, "content-type": "application/octet-stream" }, body, duplex: "half" } as RequestInit);
    const res = await app.fetch(request, small);
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("file_too_large");
    expect(pulled).toBe(false);
  });

  it("reserves quota BEFORE accepting bytes: no quota, the body is never read", async () => {
    const { tid } = await imageText();
    const tiny = await makeEnv({ STORAGE_QUOTA_BYTES: "100" });
    let pulled = false;
    const body = new ReadableStream({ pull(c) { pulled = true; c.enqueue(JPEG(200)); c.close(); } }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}${pageUrl(tid)}?filename=a.jpg&size=200`, { method: "POST", headers: { ...(await legs(ALICE)), origin: ORIGIN, "content-type": "application/octet-stream" }, body, duplex: "half" } as RequestInit);
    const res = await app.fetch(request, tiny);
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("storage_quota_exceeded");
    expect(pulled).toBe(false);
    expect(await storageOf(ALICE)).toBe(0);
  });

  it("concurrent uploads cannot jointly exceed the quota", async () => {
    const { tid, pid } = await imageText();
    const tight = await makeEnv({ STORAGE_QUOTA_BYTES: "1000" });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => up(tid, JPEG(400), `f${i}.jpg`, ALICE, tight)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 413, 413, 413]);
    expect(await storageOf(ALICE)).toBe(800);
    expect(await r2Keys(projectPrefix(pid))).toHaveLength(2);
    expect(await projectStorageBytes(env.DB, pid)).toBe(800);
  });

  it("never silently overwrites: a repeated name is a 409 and the original survives", async () => {
    const { tid } = await imageText();
    await up(tid, JPEG(10), "same.jpg");
    const second = await up(tid, PNG(20), "same.jpg");
    expect(second.status).toBe(409);
    expect((await json(second)).error.code).toBe("filename_exists");
    expect(await storageOf(ALICE)).toBe(10);
    const pages = (await json(await call(api(`/texts/${tid}/pages`)))).pages;
    expect(pages).toHaveLength(1);
    expect(pages[0].image_bytes).toBe(10);
  });

  it("enforces the per-project page cap, including across texts and under a race", async () => {
    const pid = await createProject(ALICE);
    const [a, b] = [await createText(ALICE, pid), await createText(ALICE, pid)];
    const cap = await makeEnv({ MAX_PROJECT_PAGES: "3" });
    await up(a, JPEG(10), "1.jpg", ALICE, cap);
    await up(b, JPEG(10), "2.jpg", ALICE, cap);
    await up(a, JPEG(10), "3.jpg", ALICE, cap);
    const over = await up(b, JPEG(10), "4.jpg", ALICE, cap);
    expect(over.status).toBe(409);
    expect((await json(over)).error.code).toBe("page_limit_reached");
    expect(await storageOf(ALICE)).toBe(30);

    const pid2 = await createProject(ALICE, "Race");
    const t2 = await createText(ALICE, pid2);
    const cap2 = await makeEnv({ MAX_PROJECT_PAGES: "2" });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => up(t2, JPEG(10), `r${i}.jpg`, ALICE, cap2)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE text_id = ?").bind(t2).first<{ n: number }>();
    expect(n!.n).toBe(2);
    expect(await storageOf(ALICE)).toBe(30 + 20); // losers' reservations and objects were released
    expect(await r2Keys(projectPrefix(pid2))).toHaveLength(2);
  });

  it("only image projects take page images", async () => {
    const { tid } = await pdfText();
    expect((await up(tid, JPEG(10))).status).toBe(400);
  });

  it("sanitizes the stored file name and rejects an empty one", async () => {
    expect(cleanFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanFilename("C:\\Users\\me\\scan<1>.jpg")).toBe("scan1.jpg");
    expect(cleanFilename("a\u0000b\r\n.jpg")).toBe("ab.jpg");
    expect(cleanFilename("...hidden")).toBe("hidden");
    expect(cleanFilename("x".repeat(300) + ".png").length).toBe(120);
    expect(cleanFilename("x".repeat(300) + ".png").endsWith(".png")).toBe(true);
    expect(() => cleanFilename("  ")).toThrow();
    expect(() => cleanFilename(undefined)).toThrow();
    const { tid } = await imageText();
    expect((await upload(pageUrl(tid), JPEG(10), ALICE, { query: { filename: "/" } })).status).toBe(400);
    expect(sniffImage(new Uint8Array([]))).toBeNull();
  });

  it("deleting the page and the text gives the bytes back", async () => {
    const { pid, tid } = await imageText();
    const { page } = await json(await up(tid, JPEG(300), "z.jpg"));
    await up(tid, JPEG(200), "y.jpg");
    await call(api(`/texts/${tid}/pages/${page.id}`), { method: "DELETE" });
    expect(await storageOf(ALICE)).toBe(200);
    await call(api(`/texts/${tid}`), { method: "DELETE" });
    expect(await storageOf(ALICE)).toBe(0);
    expect(await r2Keys(projectPrefix(pid))).toEqual([]);
  });
});

describe("source PDF upload", () => {
  const pdfUrl = (tid: string) => api(`/texts/${tid}/source-pdf`);
  it("stores, serves as an attachment, and refuses silent replacement", async () => {
    const { tid } = await pdfText();
    expect((await upload(pdfUrl(tid), PDF(500), ALICE, { method: "PUT", query: { filename: "paper.pdf" } })).status).toBe(201);
    expect(await storageOf(ALICE)).toBe(500);
    const get = await call(pdfUrl(tid));
    expect(get.headers.get("content-type")).toBe("application/pdf");
    expect(get.headers.get("content-disposition")).toBe('attachment; filename="paper.pdf"');
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    const again = await upload(pdfUrl(tid), PDF(300), ALICE, { method: "PUT", query: { filename: "other.pdf" } });
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("pdf_exists");
    expect(await storageOf(ALICE)).toBe(500);
  });

  it("explicit replace swaps the object, frees the old bytes and keeps counters exact", async () => {
    const { tid, pid } = await pdfText();
    await upload(pdfUrl(tid), PDF(500), ALICE, { method: "PUT", query: { filename: "a.pdf" } });
    const res = await upload(pdfUrl(tid), PDF(200), ALICE, { method: "PUT", query: { filename: "b.pdf", replace: "1" } });
    expect(res.status).toBe(201);
    expect(await storageOf(ALICE)).toBe(200);
    expect(await r2Keys(projectPrefix(pid))).toHaveLength(1);
    expect((await json(await call(api(`/texts/${tid}/html`)))).source_pdf_name).toBe("b.pdf");
  });

  it("checks %PDF- magic, a separate cap, and project type", async () => {
    const { tid } = await pdfText();
    expect((await upload(pdfUrl(tid), JPEG(100), ALICE, { method: "PUT", query: { filename: "a.pdf" } })).status).toBe(415);
    const small = await makeEnv({ MAX_PDF_BYTES: "50", MAX_FILE_BYTES: "10000" });
    expect((await upload(pdfUrl(tid), PDF(100), ALICE, { method: "PUT", query: { filename: "a.pdf" }, env: small })).status).toBe(413);
    expect(await storageOf(ALICE)).toBe(0);
    const { tid: it } = await imageText();
    expect((await upload(pdfUrl(it), PDF(10), ALICE, { method: "PUT", query: { filename: "a.pdf" } })).status).toBe(400);
    expect((await call(pdfUrl(tid))).status).toBe(404);
  });
});

describe("figure upload", () => {
  it("stores crops, lists and serves them, caps count, refuses duplicates, and frees bytes on delete", async () => {
    const { tid, pid } = await pdfText();
    const fig = await upload(api(`/texts/${tid}/figures`), PNG(100), ALICE, { query: { filename: "fig1.png" } });
    expect(fig.status).toBe(201);
    const { figure } = await json(fig);
    expect((await upload(api(`/texts/${tid}/figures`), PNG(10), ALICE, { query: { filename: "fig1.png" } })).status).toBe(409);
    expect((await upload(api(`/texts/${tid}/figures`), PDF(10), ALICE, { query: { filename: "x.png" } })).status).toBe(415);
    expect((await json(await call(api(`/texts/${tid}/figures`)))).figures).toHaveLength(1);
    const get = await call(api(`/texts/${tid}/figures/${figure.id}`));
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(await projectStorageBytes(env.DB, pid)).toBe(100);
    await call(api(`/texts/${tid}/figures/${figure.id}`), { method: "DELETE" });
    expect(await storageOf(ALICE)).toBe(0);
    expect(await r2Keys(projectPrefix(pid))).toEqual([]);
    // figures die with the text and the project
    await upload(api(`/texts/${tid}/figures`), PNG(100), ALICE, { query: { filename: "again.png" } });
    await call(api(`/projects/${pid}`), { method: "DELETE" });
    expect(await storageOf(ALICE)).toBe(0);
    expect(await r2Keys()).toEqual([]);
  });
});
