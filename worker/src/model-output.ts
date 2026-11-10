// Cleaning of model output. Deterministic, bounded, no model calls.

/** Remove reasoning blocks some models put in the visible reply. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^[\s\S]*?<\/(think|thinking|reasoning)>/i, (m) => (/<(think|thinking|reasoning)>/i.test(m) ? m : ""))
    .trim();
}

/** Collapse a phrase repeated 3+ times in a row. Iteration and depth are capped against adversarial input. */
function collapseRepeatingPhrases(text: string, depth = 0): string {
  if (text.length < 80 || depth > 20) return text;
  let iterations = 0;
  for (let patLen = Math.min(200, Math.floor(text.length / 3)); patLen >= 20; patLen--) {
    for (let start = 0; start <= text.length - patLen * 3; start++) {
      if (++iterations > 500_000) return text;
      const pattern = text.substring(start, start + patLen);
      let count = 1;
      let pos = start + patLen;
      while (pos + patLen <= text.length && text.substring(pos, pos + patLen) === pattern) {
        count++;
        pos += patLen;
      }
      if (count >= 3) return collapseRepeatingPhrases(text.substring(0, start + patLen) + text.substring(pos), depth + 1);
    }
  }
  return text;
}

/** Drop immediately repeated paragraphs and runaway repeated phrases. */
export function deduplicateOcr(text: string): string {
  const out: string[] = [];
  for (const para of text.split("\n\n")) {
    const t = para.trim();
    if (!t) continue;
    if (out.length === 0 || out[out.length - 1] !== t) out.push(t);
  }
  return out.map((p) => collapseRepeatingPhrases(p)).join("\n\n");
}

export function cleanOcr(raw: string): string {
  return deduplicateOcr(stripReasoning(raw)).trim();
}

/** Take the <section>...</section> block out of a possibly fenced reply. */
export function extractHtml(text: string): string {
  const cleaned = stripReasoning(text).replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const section = cleaned.match(/<section[\s\S]*<\/section>/i);
  return section ? section[0] : cleaned;
}

const textOf = (html: string): string =>
  html.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

const LEADING_NUMBER = /^((?:\s*<p\b[^>]*>)*\s*)(?:<(strong|b|span|em)\b[^>]*>\s*(\d{1,4})[.)]\s*<\/\2>|(\d{1,4})[.)])\s+/;
const leadingNumber = (m: RegExpExecArray): number => Number(m[3] ?? m[4]);

/**
 * Printed item numbers survive: an <ol> (without start) whose items all begin
 * with a written number ("31. ...") would render "1. 31. ...". It becomes
 * <ol start="31"> with the written numbers removed, or per-item value= when
 * the numbers are not consecutive. Lists already carrying start/type, or
 * nested lists, are left alone.
 */
export function keepPrintedNumbers(html: string): string {
  return html.replace(/<ol\b([^>]*)>((?:(?!<ol\b)[\s\S])*?)<\/ol>/gi, (whole, attrs: string, inner: string) => {
    if (/\b(start|type|reversed)\s*=/i.test(attrs) || /\breversed\b/i.test(attrs)) return whole;
    const parts = inner.split(/(<li\b[^>]*>)/i);
    const numbers: number[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      if (/\bvalue\s*=/i.test(parts[i] as string)) return whole;
      const m = LEADING_NUMBER.exec(parts[i + 1] as string);
      if (!m) return whole;
      numbers.push(leadingNumber(m));
    }
    if (numbers.length === 0) return whole;
    const consecutive = numbers.every((n, i) => n === (numbers[0] as number) + i);
    for (let i = 1, k = 0; i < parts.length; i += 2, k++) {
      parts[i + 1] = (parts[i + 1] as string).replace(LEADING_NUMBER, "$1");
      if (!consecutive) parts[i] = (parts[i] as string).replace(/^<li\b/i, `<li value="${numbers[k]}"`);
    }
    const start = consecutive && numbers[0] !== 1 ? ` start="${numbers[0]}"` : "";
    return `<ol${attrs}${start}>${parts.join("")}</ol>`;
  });
}

const TABLE_LABEL = /^(?:[ivxlc]{1,6}|[a-z]|\d{1,3})[.)]?$/i;

/**
 * A table whose first column holds only a label in its first cell ("i." with
 * empty cells below, an extra column the page does not print) gets the label
 * as a <caption> and loses that column. Tables with spans are left alone.
 */
export function liftTableLabels(html: string): string {
  return html.replace(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi, (whole, attrs: string, inner: string) => {
    if (/<caption\b|<table\b|\b(?:rowspan|colspan)\s*=/i.test(inner)) return whole;
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rows.length < 2) return whole;
    const firstCells = rows.map((r) => /^\s*<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/i.exec(r[1] as string));
    if (firstCells.some((c) => c === null)) return whole;
    const label = textOf((firstCells[0] as RegExpExecArray)[2] as string);
    if (!TABLE_LABEL.test(label) || firstCells.slice(1).some((c) => textOf((c as RegExpExecArray)[2] as string) !== "")) return whole;
    const cellsPerRow = rows.map((r) => ((r[1] as string).match(/<t[dh]\b/gi) ?? []).length);
    if (cellsPerRow.some((n) => n < 2)) return whole;
    const stripped = inner.replace(/(<tr\b[^>]*>)\s*<(t[dh])\b[^>]*>[\s\S]*?<\/\2>/gi, "$1");
    return `<table${attrs}><caption>${label}</caption>${stripped}</table>`;
  });
}

export function postprocessPageHtml(html: string, pageNumber: number): string {
  let result = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/\s+style="[^"]*"/gi, "");
  result = liftTableLabels(keepPrintedNumbers(result));
  if (!/data-page=/.test(result)) result = result.replace(/<section\b/i, `<section data-page="${pageNumber}"`);
  result = result.trim();
  return /^<section\b/i.test(result) ? result : `<section data-page="${pageNumber}">\n${result}\n</section>`;
}

export const visibleLength = (html: string): number => html.replace(/<[^>]+>/g, " ").replace(/\\[()[\]]/g, " ").replace(/\s+/g, " ").trim().length;

// ---- legacy "cleanup": normalise callout boxes, wrap in <article> (no model) ----

function wrapOrphanedHeaders(inner: string): string {
  const lines = inner.split("\n");
  const result: string[] = [];
  let inOrphan = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (/^<header>/i.test(trimmed) && !inOrphan) {
      let prev = "";
      for (let j = i - 1; j >= 0; j--) {
        if ((lines[j] as string).trim()) { prev = (lines[j] as string).trim(); break; }
      }
      if (!/<section\b/i.test(prev)) {
        inOrphan = true;
        depth = 0;
        result.push("  <section>", line);
        continue;
      }
    }
    if (inOrphan) {
      depth += (line.match(/<section\b/gi) ?? []).length - (line.match(/<\/section>/gi) ?? []).length;
      if (depth <= 0 && /^<(header>|section\b|h[12]\b|aside\b|blockquote\b|footer\b|nav\b)/i.test(trimmed)) {
        result.push("  </section>");
        inOrphan = false;
      }
    }
    result.push(line);
  }
  if (inOrphan) result.push("  </section>");
  return result.join("\n");
}

// ---- running headers and footers across pages ------------------------------

const EDGE_TAGS = "h[1-6]|p|header|footer";
const FIRST_BLOCK = new RegExp(`^(\\s*)<(${EDGE_TAGS})\\b[^>]*>([\\s\\S]*?)<\\/\\2>`, "i");
const LAST_BLOCK = new RegExp(`<(${EDGE_TAGS})\\b[^>]*>((?:(?!<(?:${EDGE_TAGS})\\b)[\\s\\S])*?)<\\/\\1>(\\s*)$`, "i");
const PAGE_NUMBER_EDGE = /^(\d{1,4})\s+|\s+(\d{1,4})$/;

interface Edge { page: number; where: "first" | "last"; key: string; printed: number | null; tag: string }

function edgeKey(inner: string): { key: string; printed: number | null } | null {
  const text = textOf(inner);
  if (text.length === 0 || text.length > 120) return null;
  if (/^\d{1,4}$/.test(text)) return { key: "", printed: Number(text) }; // a bare page number
  const m = PAGE_NUMBER_EDGE.exec(text);
  const printed = m ? Number(m[1] ?? m[2]) : null;
  const key = text.replace(PAGE_NUMBER_EDGE, "").toLowerCase();
  // At least two words: single words ("Exercises") are too often real headings.
  return key.split(" ").length >= 2 ? { key, printed } : null;
}

/** The page sections of an assembled document, with nested <section> elements (callout boxes) kept inside their page. */
function pageSections(html: string): { page: number; innerStart: number; innerEnd: number }[] {
  const out: { page: number; innerStart: number; innerEnd: number }[] = [];
  const open = /<section\b[^>]*\bdata-page="(\d+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html)) !== null) {
    const innerStart = m.index + m[0].length;
    const tags = /<section\b[^>]*>|<\/section\s*>/gi;
    tags.lastIndex = innerStart;
    let depth = 1;
    let t: RegExpExecArray | null = null;
    while (depth > 0 && (t = tags.exec(html)) !== null) depth += t[0][1] === "/" ? -1 : 1;
    if (depth !== 0 || t === null) break; // unterminated: leave the rest alone
    out.push({ page: Number(m[1]), innerStart, innerEnd: t.index });
    open.lastIndex = tags.lastIndex;
  }
  return out;
}

/** Rewrite each page section's inner HTML. */
export function mapPages(html: string, fn: (page: number, inner: string) => string): string {
  const sections = pageSections(html);
  let out = "";
  let at = 0;
  for (const s of sections) {
    out += html.slice(at, s.innerStart) + fn(s.page, html.slice(s.innerStart, s.innerEnd));
    at = s.innerEnd;
  }
  return out + html.slice(at);
}

/**
 * Remove running headers and footers the page model kept: the first or last
 * block of a page whose text (less a page number at either end) repeats as a
 * first or last block on at least three pages, with printed page numbers
 * moving in step with the pages. A bare page number counts only when it is in
 * step on at least three pages, so a lone answer "3" stays. The first
 * occurrence is kept when it is a heading: the first page of a section prints
 * the same words as its real title. Fewer than three pages: nothing changes.
 */
export function dropRunningHeads(html: string): string {
  const sections = pageSections(html).map((s) => ({ page: s.page, inner: html.slice(s.innerStart, s.innerEnd) }));
  if (sections.length < 3) return html;
  const edges: Edge[] = [];
  for (const { page, inner } of sections) {
    const first = FIRST_BLOCK.exec(inner);
    const last = LAST_BLOCK.exec(inner);
    const fk = first ? edgeKey(first[3] as string) : null;
    if (first && fk) edges.push({ page, where: "first", ...fk, tag: (first[2] as string).toLowerCase() });
    const lk = last && last.index !== first?.index ? edgeKey(last[2] as string) : null;
    if (last && lk) edges.push({ page, where: "last", ...lk, tag: (last[1] as string).toLowerCase() });
  }
  // Grouped by position and words. Printed numbers must be in step with the pages
  // (one offset); members without a number join that run. "Table 3", "Table 9" on
  // unrelated pages, or a lone answer "3", are not in step and stay.
  const byText = new Map<string, Edge[]>();
  for (const e of edges) byText.set(`${e.where}|${e.key}`, [...(byText.get(`${e.where}|${e.key}`) ?? []), e]);
  const drop = new Set<string>();
  for (const members of byText.values()) {
    const byOffset = new Map<number, Edge[]>();
    for (const e of members) if (e.printed !== null) byOffset.set(e.printed - e.page, [...(byOffset.get(e.printed - e.page) ?? []), e]);
    const run = [...byOffset.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    const group = [...run, ...members.filter((e) => e.printed === null)];
    if (new Set(group.map((e) => e.page)).size < 3) continue;
    const sorted = [...group].sort((a, b) => a.page - b.page);
    sorted.forEach((e, i) => {
      if (i === 0 && /^h[1-6]$/.test(e.tag)) return;
      drop.add(`${e.page}|${e.where}`);
    });
  }
  if (drop.size === 0) return html;
  return mapPages(html, (page, inner) => {
    let next = inner;
    if (drop.has(`${page}|first`)) next = next.replace(FIRST_BLOCK, "$1");
    if (drop.has(`${page}|last`)) next = next.replace(LAST_BLOCK, "$3");
    return next;
  });
}

// ---- checks a person should know about (reported, never "fixed") -----------

export type PageWarning = "figure_values" | "numbering_restarted";

const COORDINATE = /\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)|\b[xy]\s*=\s*-?\d/;

/**
 * figure_values: a figure description states coordinates or values (models
 * misread graphs; see docs/model-policy.md). numbering_restarted: the page's
 * text layer has items numbered from N > 1 but the output has a list that
 * restarts at 1.
 */
export function pageWarnings(html: string, hint = ""): PageWarning[] {
  const out: PageWarning[] = [];
  const captions = [...html.matchAll(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/gi)].map((m) => textOf(m[1] as string).replace(/\\[()[\]]/g, " "));
  if (captions.some((t) => COORDINATE.test(t))) out.push("figure_values");
  const printed = [...hint.matchAll(/(?:^|\n)\s*(\d{1,4})\.\s/g)].map((m) => Number(m[1]));
  const lowest = printed.length >= 2 ? Math.min(...printed) : 1;
  if (lowest > 1) {
    const restarts = [...html.matchAll(/<ol\b([^>]*)>([\s\S]*?)<\/ol>/gi)].some(([, attrs, inner]) => !/\b(start|type)\s*=/i.test(attrs as string) && !/\bvalue\s*=/i.test(inner as string) && !LEADING_NUMBER.test((inner as string).split(/<li\b[^>]*>/i)[1] ?? ""));
    if (restarts) out.push("numbering_restarted");
  }
  return out;
}

export function cleanupDocumentHtml(html: string): string {
  const normalized = mapPages(dropRunningHeads(html), (_page, inner) => wrapOrphanedHeaders(inner));
  return /<article\b/i.test(normalized) ? normalized : `<article class="pdf-html-document">\n${normalized}\n</article>`;
}

export function toDataUri(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}
