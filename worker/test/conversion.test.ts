import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, PDF, addMember, api, call, createProject, createText, json, upload } from "./helpers";
import { chatCalls, gatewayEnv } from "./gateway-stub";
import { runRetentionSweep } from "../src/retention";
import { CONVERSION_PAGE_MAX_BYTES } from "../src/conversion";

// The resume store of a PDF conversion in progress (migration 0011).
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const SRC = "sha256-0123456789abcdef";

async function team() {
  const pid = await createProject(ALICE, "PDF", { project_type: "pdf_to_html" });
  await addMember(ALICE, pid, BOB, "editor");
  await addMember(ALICE, pid, CAROL, "viewer");
  const tid = await createText(ALICE, pid);
  return { pid, tid };
}
const parse = (tid: string, e: Env, body: Record<string, unknown>, as = ALICE) =>
  call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: IMG, total_pages: 3, ...body }, env: e, as });
type Env = Awaited<ReturnType<typeof gatewayEnv>>;
const rows = async (tid: string) => (await env.DB.prepare("SELECT page_number, source FROM conversion_pages WHERE text_id = ? ORDER BY page_number").bind(tid).all<any>()).results;

describe("a conversion in progress is kept so a reload resumes", () => {
  it("each page converted with a source is kept; the run is listed without pages, and its pages by source", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "<section data-page=\"1\"><p>Converted.</p></section>" }) });
    const { tid } = await team();
    expect(await json(await parse(tid, e, { page_number: 1, resume_source: SRC }))).toMatchObject({ kept: true });
    expect(await json(await parse(tid, e, { page_number: 2, resume_source: SRC }, BOB))).toMatchObject({ kept: true });
    // No source named: one page, nothing kept (the previous behaviour).
    expect(await json(await parse(tid, e, { page_number: 3 }))).toMatchObject({ kept: false });
    expect(chatCalls(e)).toHaveLength(3);
    const summary = await json(await call(api(`/texts/${tid}/conversion`), { as: BOB }));
    expect(summary.run).toMatchObject({ source: SRC, kept: 2, total_pages: 3 });
    expect(summary.pages).toBeUndefined();
    const got = await json(await call(api(`/texts/${tid}/conversion?source=${SRC}`)));
    expect(got.pages.map((p: any) => [p.page_number, p.math, typeof p.html])).toEqual([[1, false, "string"], [2, false, "string"]]);
    expect((await json(await call(api(`/texts/${tid}/conversion?source=sha256-other`)))).pages).toEqual([]);
    // Viewers do not convert, so they do not see a run in progress; a bad source is refused.
    expect((await call(api(`/texts/${tid}/conversion`), { as: CAROL })).status).toBe(403);
    expect((await call(api(`/texts/${tid}/conversion?source=${encodeURIComponent("a b")}`))).status).toBe(400);
  });

  it("a page of another PDF, or another page count, drops the kept pages first: a run never mixes two PDFs", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "<p>x</p>" }) });
    const { tid } = await team();
    await parse(tid, e, { page_number: 1, resume_source: SRC });
    await parse(tid, e, { page_number: 2, resume_source: SRC });
    await parse(tid, e, { page_number: 1, resume_source: "sha256-new" });
    expect(await rows(tid)).toEqual([{ page_number: 1, source: "sha256-new" }]);
    await parse(tid, e, { page_number: 2, resume_source: "sha256-new", total_pages: 5 });
    expect(await rows(tid)).toEqual([{ page_number: 2, source: "sha256-new" }]);
  });

  it("bounded: a run over the project page cap or an oversized page is not kept", async () => {
    const big = `<p>${"x".repeat(CONVERSION_PAGE_MAX_BYTES)}</p>`;
    const e = await gatewayEnv({ chat: () => ({ text: big }) });
    const { tid } = await team();
    expect(await json(await parse(tid, e, { page_number: 1, resume_source: SRC }))).toMatchObject({ kept: false });
    const small = await gatewayEnv({ chat: () => ({ text: "<p>x</p>" }) });
    expect(await json(await parse(tid, small, { page_number: 1, resume_source: SRC, total_pages: 301 }))).toMatchObject({ kept: false });
    expect(await rows(tid)).toEqual([]);
  });

  it("cleared when the conversion is saved, when the source PDF is replaced, on request, and after a week", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "<p>x</p>" }) });
    const { tid } = await team();
    await parse(tid, e, { page_number: 1, resume_source: SRC });
    // A manual save does not end the run.
    await call(api(`/texts/${tid}/html`), { method: "PUT", body: { html_content: "<p>a</p>" } });
    expect(await rows(tid)).toHaveLength(1);
    await call(api(`/texts/${tid}/html`), { method: "PUT", body: { html_content: "<p>b</p>", reason: "conversion" } });
    expect(await rows(tid)).toEqual([]);

    await parse(tid, e, { page_number: 1, resume_source: SRC });
    expect((await upload(api(`/texts/${tid}/source-pdf`), PDF(), ALICE, { method: "PUT", query: { filename: "s.pdf" } })).status).toBe(201);
    expect(await rows(tid)).toEqual([]);

    await parse(tid, e, { page_number: 1, resume_source: SRC });
    expect((await call(api(`/texts/${tid}/conversion`), { method: "DELETE", as: CAROL })).status).toBe(403);
    expect(await json(await call(api(`/texts/${tid}/conversion`), { method: "DELETE", as: BOB }))).toMatchObject({ cleared: 1 });

    await parse(tid, e, { page_number: 1, resume_source: SRC });
    expect((await json(await call(api(`/texts/${tid}/conversion`)))).run).not.toBeNull();
    await runRetentionSweep(env as any, Date.now() + 8 * 86_400_000);
    expect(await rows(tid)).toEqual([]);
  });

  it("deleted with the text", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "<p>x</p>" }) });
    const { tid } = await team();
    await parse(tid, e, { page_number: 1, resume_source: SRC });
    expect((await call(api(`/texts/${tid}`), { method: "DELETE" })).status).toBe(200);
    expect(await rows(tid)).toEqual([]);
  });
});
