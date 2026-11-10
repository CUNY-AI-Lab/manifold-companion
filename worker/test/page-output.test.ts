// Page-model output normalisers and warnings, locked to real replies from the
// 2026-11-10 live evaluation (test/fixtures/eval-pages.json; see its _source).
import { describe, expect, it } from "vitest";
import eval_ from "./fixtures/eval-pages.json";
import { cleanupDocumentHtml, dropRunningHeads, keepPrintedNumbers, liftTableLabels, pageWarnings } from "../src/model-output";
import { DEFAULT_OCR_PROMPT, HTML_PAGE_SYSTEM } from "../src/prompts";
import { sanitizeHtml } from "../src/sanitize/html";
import { parsePageHtml } from "../src/task-specs";
import { ALICE, api, call, createProject, createText, json } from "./helpers";
import { gatewayEnv } from "./gateway-stub";
import { CATALOG } from "./catalog.fixture";

const F = eval_ as Record<string, string>;
const tables = (html: string) => [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1] as string);
const cells = (row: string) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => (m[1] as string).replace(/<[^>]+>/g, "").trim());
const rows = (table: string) => [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => cells(m[1] as string));

describe("prompts carry the fidelity rules", () => {
  it("page HTML: no running heads, printed numbers kept, no added words, no values read off graphs, labels not in table columns", () => {
    expect(HTML_PAGE_SYSTEM).toMatch(/Leave out the running header and running footer/);
    expect(HTML_PAGE_SYSTEM).toMatch(/<ol start="31">/);
    expect(HTML_PAGE_SYSTEM).toMatch(/Do NOT add connecting words such as "or"/);
    expect(HTML_PAGE_SYSTEM).toMatch(/do NOT state coordinates, points, intercepts, endpoints or values read off them/);
    expect(HTML_PAGE_SYSTEM).toMatch(/never in an extra column of the table/);
    expect(HTML_PAGE_SYSTEM).toMatch(/<figure class="needs-image">/);
  });
  it("OCR: the same rules in Markdown terms", () => {
    expect(DEFAULT_OCR_PROMPT).toMatch(/running header or footer/);
    expect(DEFAULT_OCR_PROMPT).toMatch(/Never renumber/);
    expect(DEFAULT_OCR_PROMPT).toMatch(/do NOT state coordinates/);
    expect(DEFAULT_OCR_PROMPT).toMatch(/Do NOT add connecting words/);
  });
  it("the figure marker class survives the sanitizer", () => {
    expect(sanitizeHtml('<figure class="needs-image"><figcaption>Figure: 25. a piecewise graph</figcaption></figure>')).toContain('class="needs-image"');
  });
});

describe("printed list numbers", () => {
  it("written numbers in a plain <ol> become start= (they would render as 1. 31.)", () => {
    expect(keepPrintedNumbers("<ol><li>31. \\(f(x)\\)</li><li>32. b</li></ol>")).toBe('<ol start="31"><li>\\(f(x)\\)</li><li>b</li></ol>');
    expect(keepPrintedNumbers("<ol>\n<li><p>41. a</p></li>\n<li><p><strong>42.</strong> b</p></li>\n</ol>")).toBe('<ol start="41">\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ol>');
  });
  it("non-consecutive numbers keep each value; lists from 1 just lose the duplicate numbers", () => {
    expect(keepPrintedNumbers("<ol><li>3. a</li><li>7. b</li></ol>")).toBe('<ol><li value="3">a</li><li value="7">b</li></ol>');
    expect(keepPrintedNumbers("<ol><li>1. a</li><li>2. b</li></ol>")).toBe("<ol><li>a</li><li>b</li></ol>");
  });
  it("lists with start/type/value, unnumbered items, or numbers that are content are left alone", () => {
    for (const html of ['<ol start="31"><li>31. a</li></ol>', '<ol type="a"><li>1. a</li></ol>', '<ol><li value="4">4. a</li></ol>', "<ol><li>a</li><li>32. b</li></ol>", "<ol><li>3 apples</li><li>4 pears</li></ol>"]) {
      expect(keepPrintedNumbers(html)).toBe(html);
    }
  });
  it("DeepSeek ch1-p19 (run 2) keeps <ol start=\"41\"> through parsing and the sanitizer", () => {
    expect(parsePageHtml(F.deepseek_ch1_p19 as string, 19).html).toContain('<ol start="41">');
  });
});

describe("table labels in an extra column (Magistral ch1-p19)", () => {
  const before = tables(F.magistral_ch1_p19 as string);
  const { html } = parsePageHtml(F.magistral_ch1_p19 as string, 19, F.hint_ch1_p19);
  const after = tables(html);
  it("the reply put i.-vi. in an empty first column of all 12 tables", () => {
    expect(before).toHaveLength(12);
    for (const t of before) expect(rows(t).every((r) => r.length === 3)).toBe(true);
  });
  it("after parsing: a caption per table, two columns, and every one of the 72 values unchanged", () => {
    expect(after).toHaveLength(12);
    expect(after.map((t) => /<caption>([^<]*)<\/caption>/.exec(t)?.[1])).toEqual(["i.", "ii.", "iii.", "iv.", "v.", "vi.", "i.", "ii.", "iii.", "iv.", "v.", "vi."]);
    for (let k = 0; k < 12; k++) {
      const a = rows(after[k] as string);
      expect(a.every((r) => r.length === 2)).toBe(true);
      expect(a).toEqual(rows(before[k] as string).map((r) => r.slice(1)));
    }
    expect(rows(after[0] as string).slice(1)).toEqual([["-2", "-0.5"], ["-1", "-1"], ["0", "_"], ["1", "1"], ["2", "0.5"], ["3", "0.33"]]);
  });
  it("a real first column, spans, or a label that is not a label are left alone", () => {
    const real = "<table><tr><th>In</th><th>Out</th></tr><tr><td>1</td><td>2</td></tr></table>";
    const spans = '<table><tr><td>i.</td><td colspan="2">x</td></tr><tr><td></td><td>1</td><td>2</td></tr></table>';
    const word = "<table><tr><td>Total</td><td>x</td></tr><tr><td></td><td>1</td></tr></table>";
    for (const t of [real, spans, word]) expect(liftTableLabels(t)).toBe(t);
  });
});

describe("page warnings", () => {
  it("DeepSeek's graph descriptions with coordinates (ch1-p35, both runs) are flagged figure_values", () => {
    expect(parsePageHtml(F.deepseek_ch1_p35 as string, 35, F.hint_ch1_p35).warnings).toContain("figure_values");
    expect(parsePageHtml(F.deepseek_ch1_p35_run1 as string, 35, F.hint_ch1_p35).warnings).toContain("figure_values");
  });
  it("Magistral's cases 31-36 in an <ol> without start (ch1-p35) are flagged numbering_restarted", () => {
    const { warnings, html } = parsePageHtml(F.magistral_ch1_p35 as string, 35, F.hint_ch1_p35);
    expect(warnings).toEqual(["numbering_restarted"]);
    expect(html).toMatch(/<ol>/);
  });
  it("no false alarms: a worked example with values in the text, and a numbered page whose lists keep their numbers", () => {
    expect(parsePageHtml(F.magistral_ch7_p15 as string, 15).warnings).toEqual([]);
    expect(pageWarnings('<ol start="31"><li>a</li></ol><figure><figcaption>Figure: 25. a piecewise graph with three pieces</figcaption></figure>', "25.\n31. f(x)\n32. g(x)")).toEqual([]);
    expect(pageWarnings("<ol><li>a</li></ol>", "1. first\n2. second")).toEqual([]);
  });
});

describe("running headers and footers across pages", () => {
  // Header strings exactly as the models wrote them in the run; the book alternates
  // "<even page> Chapter 7" and "Section 7.1 ... <odd page>"; PDF page n prints n + 452.
  const page = (n: number, first: string, body: string, last = "") => `<section data-page="${n}">\n${first}\n${body}\n${last}</section>`;
  const doc = [
    page(1, "<h1>Section 7.1 Solving Trigonometric Equations and Identities</h1>", "<p>In this section we solve equations.</p>", "<p>453</p>\n"),
    page(2, "<p>454 Chapter 7</p>", "<section><header><h3>Example 1</h3></header><p>Solve \\(\\sin(x)=1\\).</p></section>"),
    page(3, "<header><p>Section 7.1 Solving Trigonometric Equations and Identities 455</p></header>", "<p>Using the positive square root,</p>", "<p>455</p>\n"),
    page(4, "<p>456 Chapter 7</p>", "<h2>Section 7.1 Exercises</h2><ol><li>a</li></ol>", "<p>3</p>\n"),
    page(5, "<h2>Section 7.1 Solving Trigonometric Equations and Identities</h2>", "<p>More text.</p>", "<p>457</p>\n"),
    page(6, "<p>458 Chapter 7</p>", "<section><header><h3>Example 7</h3></header><p>Solve.</p></section>"),
  ].join("\n");
  const out = dropRunningHeads(doc);
  it("drops every repeat, with or without the page number, as <p>, <header> or a heading", () => {
    expect(out).not.toMatch(/Chapter 7/);
    expect(out.match(/Solving Trigonometric Equations and Identities/g)).toHaveLength(1);
    expect(out).toMatch(/<h1>Section 7\.1 Solving Trigonometric Equations and Identities<\/h1>/); // first occurrence, a heading: the section's real title
    expect(out).not.toMatch(/<p>45[357]<\/p>/); // bare page numbers, in step on three pages
    expect(out).toContain("<p>3</p>"); // a lone number is content
  });
  it("keeps body content, a real heading printed once, and callout boxes", () => {
    for (const keep of ["<h2>Section 7.1 Exercises</h2>", "<h3>Example 1</h3>", "<h3>Example 7</h3>", "Using the positive square root,", "<p>More text.</p>"]) expect(out).toContain(keep);
    expect(out.match(/<section\b/g)).toHaveLength(8);
    expect(out.match(/<\/section>/g)).toHaveLength(8);
  });
  it("numbers out of step with the pages are not a running head; neither are single words or two pages", () => {
    const notInStep = [page(1, "<p>Table 3 summary</p>", "<p>x</p>"), page(2, "<p>Table 9 summary</p>", "<p>y</p>"), page(3, "<p>Table 4 summary</p>", "<p>z</p>")].join("\n");
    expect(dropRunningHeads(notInStep)).toBe(notInStep);
    const singleWord = [1, 2, 3].map((n) => page(n, "<h2>Exercises</h2>", `<p>Item ${n}</p>`)).join("\n");
    expect(dropRunningHeads(singleWord)).toBe(singleWord);
    const twoPages = [1, 2].map((n) => page(n, "<p>454 Chapter 7</p>", `<p>Item ${n}</p>`)).join("\n");
    expect(dropRunningHeads(twoPages)).toBe(twoPages);
  });
  it("the cleanup route's function applies it, and keeps nested callout sections inside their page", () => {
    const cleaned = cleanupDocumentHtml(`<article class="pdf-html-document">\n${doc}\n</article>`);
    expect(cleaned).not.toMatch(/Chapter 7/);
    expect(cleaned).toContain("<h3>Example 7</h3>");
  });
});

describe("through the routes", () => {
  it("parse-page returns the warnings with the page; cleanup drops running heads", async () => {
    const e = await gatewayEnv({ catalog: () => Response.json(CATALOG), chat: () => ({ text: F.deepseek_ch1_p35 as string }) });
    const project = await createProject(ALICE, "P", { project_type: "pdf_to_html" });
    const tid = await createText(ALICE, project);
    const r = await json(await call(api(`/texts/${tid}/parse-page`), { method: "POST", body: { image: "data:image/png;base64,iVBORw0KGgo=", page_number: 35, text_hint: F.hint_ch1_p35, math: true }, env: e }));
    expect(r.warnings).toEqual(["figure_values"]);
    const pages = [1, 2, 3].map((n) => `<section data-page="${n}"><p>${452 + n} Chapter 7</p><p>Body ${n}</p></section>`).join("");
    const cleaned = await json(await call(api(`/texts/${tid}/html/cleanup`), { method: "POST", body: { html: pages }, env: e }));
    expect(cleaned.html).not.toMatch(/Chapter 7/);
    expect(cleaned.html).toMatch(/Body 3/);
  });
});
