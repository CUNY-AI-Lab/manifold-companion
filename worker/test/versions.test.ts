// Version history: why each version was saved, who by, per-page listing and pruning.
import { describe, expect, it } from "vitest";
import { ALICE, BOB, JPEG, addMember, api, call, createProject, createText, json, seedPage, upload } from "./helpers";
import { CAPS } from "../src/content";
import { gatewayEnv } from "./gateway-stub";

const put = (path: string, body: unknown, as = ALICE) => call(api(path), { method: "PUT", as, body });
const post = (path: string, body: unknown = {}, opts: { as?: string; env?: any } = {}) => call(api(path), { method: "POST", body, ...opts });
const list = async (tid: string, query: string, as = ALICE) => (await json(await call(api(`/texts/${tid}/versions?${query}`), { as }))).versions as any[];

describe("version reasons", () => {
  it("HTML: a manual save, a conversion and a restore each label the version of the content they replaced", async () => {
    const pid = await createProject(ALICE, "PDF", { project_type: "pdf_to_html" });
    const tid = await createText(ALICE, pid);
    await put(`/texts/${tid}/html`, { html_content: "<p>first conversion</p>", reason: "conversion" }); // nothing to snapshot yet
    await put(`/texts/${tid}/html`, { html_content: "<p>edited</p>" }); // replaces the conversion: a manual save
    await put(`/texts/${tid}/html`, { html_content: "<p>second conversion</p>", reason: "conversion" }); // replaces the edit
    let vs = await list(tid, "type=html");
    expect(vs.map((v) => v.reason)).toEqual(["conversion", "save"]);
    const edited = vs[0];
    expect((await post(`/texts/${tid}/versions/${edited.id}/revert`)).status).toBe(200);
    vs = await list(tid, "type=html");
    expect(vs.map((v) => v.reason)).toEqual(["restore", "conversion", "save"]);
    expect((await json(await call(api(`/texts/${tid}/versions/${vs[0].id}`)))).version).toMatchObject({ content: "<p>second conversion</p>", reason: "restore" });
    expect((await json(await call(api(`/texts/${tid}/html`)))).html_content).toBe("<p>edited</p>");
    expect((await put(`/texts/${tid}/html`, { html_content: "<p>x</p>", reason: "restore" })).status).toBe(400); // only save|conversion from the client
  });

  it("pages: an OCR run, a hand save and a restore are labelled; the author is shown by display name", async () => {
    const e = await gatewayEnv({ chat: () => ({ text: "Model text" }) });
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid);
    await addMember(ALICE, pid, BOB, "editor");
    await put("/profile", { display_name: "Bob Editor" }, BOB);
    const pageId = (await json(await upload(api(`/texts/${tid}/pages`), JPEG(256), ALICE, { query: { filename: "p1.jpg" }, env: e }))).page.id as string;
    await post(`/texts/${tid}/pages/${pageId}`, { text: "Original" });
    await post(`/texts/${tid}/pages/${pageId}`, { text: "Hand-corrected." }, { as: BOB });
    expect((await post(`/texts/${tid}/pages/${pageId}/ocr`, { overwrite: true }, { env: e })).status).toBe(200);
    const vs = await list(tid, `type=page&page=${pageId}`);
    // The OCR run (by Alice, no display name) replaced Bob's correction; Bob's save replaced the original.
    expect(vs.map((v) => [v.reason, v.author_name ?? null])).toEqual([["ocr", null], ["save", "Bob Editor"]]);
    expect((await post(`/texts/${tid}/versions/${vs[0].id}/revert`)).status).toBe(200);
    expect((await list(tid, `type=page&page=${pageId}`))[0].reason).toBe("restore");
  });
});

describe("page versions are listed and kept per page", () => {
  it("?page= lists one page's versions; another text's page id is 404", async () => {
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid);
    const a = await seedPage(tid, { filename: "a.jpg", ocr: "a0" });
    const b = await seedPage(tid, { filename: "b.jpg", ocr: "b0", pageNumber: 2 });
    await post(`/texts/${tid}/pages/${a}`, { text: "a1" });
    await post(`/texts/${tid}/pages/${b}`, { text: "b1" });
    await post(`/texts/${tid}/pages/${b}`, { text: "b2" });
    expect((await list(tid, `type=page&page=${a}`)).map((v) => v.page_filename)).toEqual(["a.jpg"]);
    expect(await list(tid, `type=page&page=${b}`)).toHaveLength(2);
    expect(await list(tid, "type=page")).toHaveLength(3);
    const other = await seedPage(await createText(ALICE, pid, "Other"), { ocr: "z" });
    expect((await call(api(`/texts/${tid}/versions?type=page&page=${other}`))).status).toBe(404);
    expect((await call(api(`/texts/${tid}/versions?type=html&page=${a}`))).status).toBe(400);
  });

  it("re-reading one page many times never prunes another page's history", async () => {
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid);
    const a = await seedPage(tid, { filename: "a.jpg", ocr: "a0" });
    const b = await seedPage(tid, { filename: "b.jpg", ocr: "b0", pageNumber: 2 });
    await post(`/texts/${tid}/pages/${b}`, { text: "b1" });
    for (let i = 1; i <= CAPS.maxPageVersions + 3; i += 1) await post(`/texts/${tid}/pages/${a}`, { text: `a${i}` });
    expect(await list(tid, `type=page&page=${a}`)).toHaveLength(CAPS.maxPageVersions);
    expect(await list(tid, `type=page&page=${b}`)).toHaveLength(1);
  }, 60_000);
});
