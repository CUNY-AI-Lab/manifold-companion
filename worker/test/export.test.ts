import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { ALICE, BOB, CAROL, PNG, addMember, api, call, createProject, createText, json, seedPage, upload } from "./helpers";
import { convertHtmlTexToMathML, escapeYaml, EXPORT_LIMITS } from "../src/export";
import fixture from "./fixtures/export-fixture.json";
import golden from "./fixtures/legacy-export.golden.json";

const sha256 = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Seed one fixture project through the real API (and seedPage for OCR text). */
async function seedFixture(key: "md" | "html") {
  const fp = fixture.projects.find((p) => p.key === key)!;
  const pid = await createProject(ALICE, fp.name, { project_type: fp.project_type, default_language: fp.default_language, ...(fp.description ? { description: fp.description } : {}) });
  const textIds = new Map<string, string>();
  for (const t of fp.texts as any[]) {
    const tid = await createText(ALICE, pid, t.name);
    textIds.set(t.key, tid);
    (t.pages ?? []).forEach(() => undefined);
    for (const [i, text] of ((t.pages ?? []) as string[]).entries()) await seedPage(tid, { filename: `p${i + 1}.jpg`, pageNumber: i + 1, ocr: text === "" ? null : text });
    if (t.metadata) expect((await call(api(`/texts/${tid}/metadata`), { method: "POST", body: t.metadata })).status).toBe(200);
    for (const f of (t.figures ?? []) as string[]) {
      expect((await upload(api(`/texts/${tid}/figures`), b64((fixture as any).figureFiles[f]), ALICE, { query: { filename: f } })).status).toBe(201);
    }
    if (t.html) expect((await call(api(`/texts/${tid}/html`), { method: "PUT", body: { html_content: t.html } })).status).toBe(200);
  }
  const toc = (nodes: any[]): any[] => nodes.map((n) => ({ type: n.type, label: n.label, ...(n.textKey ? { textId: textIds.get(n.textKey) } : {}), children: toc(n.children ?? []) }));
  return { pid, textIds, request: { meta: fp.request.meta, toc: toc(fp.request.toc) } };
}

async function exportZip(pid: string, body: unknown, as = ALICE) {
  const res = await call(api(`/projects/${pid}/export`), { method: "POST", body, as });
  return { res, files: res.status === 200 ? unzipSync(new Uint8Array(await res.arrayBuffer())) : null };
}

// The one attribute the Worker deliberately removes: every exported body is sanitized.
const LEGACY_STYLE = / style="display:block math;"/g;

describe("export matches the legacy exporter on the same input", () => {
  for (const key of ["md", "html"] as const) {
    it(`${key} project: same entries, same order, same bytes`, async () => {
      const { pid, request } = await seedFixture(key);
      const { res, files } = await exportZip(pid, request);
      expect(res.status).toBe(200);
      const expected = (golden.projects as any)[key] as { name: string; text?: string; sha256?: string }[];
      expect(Object.keys(files!)).toEqual(expected.map((e) => e.name));
      for (const e of expected) {
        const got = files![e.name]!;
        if (e.text !== undefined) expect(strFromU8(got), e.name).toBe(e.text.replace(LEGACY_STYLE, ""));
        else expect(await sha256(got), e.name).toBe(e.sha256);
      }
    });
  }

  it("only referenced figures of the text are packed; the unreferenced one is not", async () => {
    const { pid, request } = await seedFixture("html");
    const { files } = await exportZip(pid, request);
    expect(Object.keys(files!).filter((n) => n.startsWith("images-"))).toEqual(["images-01/page-1-fig-1.png"]);
  });
});

describe("export behaviour", () => {
  it("is a ZIP attachment with nosniff, a UTF-8 file name and no caching", async () => {
    const pid = await createProject(ALICE, "Café Notes");
    const tid = await createText(ALICE, pid);
    const { res } = await exportZip(pid, { toc: [{ type: "text", textId: tid, label: "x" }] });
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Caf__Notes.zip"; filename*=UTF-8''Caf%C3%A9%20Notes.zip`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("exports the edited full text of an image text when there is one (legacy ignored it)", async () => {
    const pid = await createProject(ALICE);
    const tid = await createText(ALICE, pid, "T");
    await seedPage(tid, { ocr: "raw page" });
    await call(api(`/texts/${tid}/save`), { method: "POST", body: { text: "Edited whole text" } });
    const { files } = await exportZip(pid, { toc: [{ type: "text", textId: tid, label: "T" }] });
    expect(strFromU8(files!["text-01-t.md"]!)).toMatch(/\n\nEdited whole text$/);
  });

  it("a viewer can export (legacy) but only an editor's export saves the export settings", async () => {
    const pid = await createProject(ALICE);
    await addMember(ALICE, pid, BOB, "editor");
    await addMember(ALICE, pid, CAROL, "viewer");
    const tid = await createText(ALICE, pid);
    const body = { toc: [{ type: "text", textId: tid, label: "x" }], meta: { title: "Viewer's" }, tocFlat: [{ id: tid }] };
    expect((await exportZip(pid, body, CAROL)).res.status).toBe(200);
    expect((await json(await call(api(`/projects/${pid}/export-settings`), { as: CAROL }))).settings).toBeNull();
    expect((await exportZip(pid, { ...body, meta: { title: "Editor's" } }, BOB)).res.status).toBe(200);
    expect((await json(await call(api(`/projects/${pid}/export-settings`), { as: CAROL }))).settings.meta.title).toBe("Editor's");
  });

  it("refuses texts of another project, with the same answer as a missing text", async () => {
    const mine = await createProject(ALICE);
    const theirs = await createProject(BOB);
    const other = await createText(BOB, theirs);
    const a = await call(api(`/projects/${mine}/export`), { method: "POST", body: { toc: [{ type: "text", textId: other, label: "x" }] } });
    const b = await call(api(`/projects/${mine}/export`), { method: "POST", body: { toc: [{ type: "text", textId: "00000000-0000-4000-8000-000000000000", label: "x" }] } });
    expect(a.status).toBe(400);
    expect((await json(a)).error.code).toBe("toc_text_unknown");
    expect((await json(b)).error.message).toBe("Every text in the table of contents must belong to this project.");
  });

  it("validates the table of contents: empty, too deep, too many, malformed", async () => {
    const pid = await createProject(ALICE);
    const deep = (n: number): any => (n === 0 ? { type: "section", label: "s", children: [] } : { type: "section", label: "s", children: [deep(n - 1)] });
    for (const [toc, code] of [[[], "toc_empty"], [[deep(11)], "toc_too_deep"], [Array(EXPORT_LIMITS.nodes + 1).fill({ type: "section", label: "s" }), "toc_too_large"], [[{ type: "evil" }], "toc_invalid"], [[{ type: "section", label: "" }], "toc_invalid"]] as const) {
      const res = await call(api(`/projects/${pid}/export`), { method: "POST", body: { toc } });
      expect((await json(res)).error.code, code).toBe(code);
    }
  });

  it("an export over the budget is refused BEFORE streaming, with a clean 413", async () => {
    const pid = await createProject(ALICE, "Big", { project_type: "pdf_to_html" });
    const tid = await createText(ALICE, pid);
    await call(api(`/texts/${tid}/html`), { method: "PUT", body: { html_content: "<p>x</p>" } });
    await env.DB.prepare("UPDATE texts SET html_bytes = ?1 WHERE id = ?2").bind(EXPORT_LIMITS.textBytes, tid).run();
    const res = await call(api(`/projects/${pid}/export`), { method: "POST", body: { toc: [{ type: "text", textId: tid, label: "x" }] } });
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("export_too_large");
  });

  it("streams many figures and texts into a valid ZIP", async () => {
    const pid = await createProject(ALICE, "Many", { project_type: "pdf_to_html" });
    const toc = [];
    for (let t = 0; t < 4; t += 1) {
      const tid = await createText(ALICE, pid, `T${t}`);
      const imgs = [];
      for (let f = 0; f < 6; f += 1) {
        expect((await upload(api(`/texts/${tid}/figures`), PNG(300_000 + f), ALICE, { query: { filename: `fig-${f}.png` } })).status).toBe(201);
        imgs.push(`<img src="fig-${f}.png" alt="f">`);
      }
      await call(api(`/texts/${tid}/html`), { method: "PUT", body: { html_content: `<p>${"words ".repeat(20000)}\\(a_${t}\\)</p>${imgs.join("")}` } });
      toc.push({ type: "text", textId: tid, label: `T${t}` });
    }
    const { files } = await exportZip(pid, { toc });
    expect(Object.keys(files!)).toHaveLength(4 * 7 + 1);
    expect(files!["images-03/fig-5.png"]!.byteLength).toBe(300_005);
    expect(strFromU8(files!["text-04-t3.html"]!)).toContain('<img src="images-04/fig-0.png" alt="f">');
  });

  it("TeX conversion: hostile TeX produces no link or script, and entity-escaped TeX converts", () => {
    const out = convertHtmlTexToMathML("<p>\\(\\href{javascript:alert(1)}{x}\\) \\(x &lt; y\\)</p>");
    // temml's trust is off: \href renders as red error text, never as a link.
    expect(out).not.toMatch(/href=|<a[ >]|javascript:/);
    expect(out).toContain("<mo>&lt;</mo>");
  });

  it("YAML values cannot break out of their line", () => {
    expect(escapeYaml('a"b\\c\nd: e\r\tf\u0001')).toBe('a\\"b\\\\c\\nd: e\\r\\tf');
  });
});
