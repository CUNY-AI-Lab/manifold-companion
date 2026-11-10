// Manifold ingestion ZIP, built in the Worker and STREAMED to the browser.
//
// Structure is the legacy exporter's (server/routes/export.js), checked against
// a golden produced by running that route unmodified (test/export.test.ts):
//   section-NN-<slug>.md            a "# Label" page for each TOC section
//   text-NN-<slug>.md               image_to_markdown texts (and HTML texts with no HTML yet)
//   images-NN/<figure>              figures an HTML text references, then
//   text-NN-<slug>.html             PDF-to-HTML texts, TeX converted to MathML (temml)
//   manifest.yml                    meta + recursive toc, last
// NN numbers every TOC node in pre-order (depth-first), as legacy did.
//
// Deliberate differences from legacy, each a fix:
//   - every HTML body goes through sanitizeHtml after TeX->MathML, so the ZIP
//     holds sanitized HTML only (temml's `style="display:block math;"` is the
//     one attribute this removes; `display="block"` remains);
//   - an image text exports its edited full text (compiled) when one exists;
//     legacy ignored it and always joined the raw page texts;
//   - YAML values escape newlines, tabs and control characters (legacy broke the
//     manifest with a newline in a label);
//   - figures are matched by the text's own figure file names, not by the
//     legacy `page-*.ext` pattern, and HTML entities inside TeX are decoded
//     before conversion (stored HTML escapes `<` in `\(x < y\)`).
//
// Limits (one request, one isolate of 128 MB):
//   - memory: entries are written one at a time; figures stream from R2 through
//     a stored (uncompressed) entry; text entries are deflated in 64 KiB pushes;
//     the output stream holds at most a few chunks (writer.ready backpressure).
//     Peak is about one HTML body (<= 5 MiB stored), its MathML expansion, and
//     the deflate window, far below 128 MB;
//   - CPU (default 30 s): deflated text is capped at EXPORT_LIMITS.textBytes
//     (64 MiB, ~3-6 s of JS deflate) and stored figures at
//     EXPORT_LIMITS.binaryBytes (256 MiB, CRC only); both are checked from D1
//     sizes BEFORE the first byte is sent, so an export that would not fit is a
//     clean 413, never a broken download;
//   - TOC: at most 1000 nodes, depth 10, 2000 ZIP entries.
import { ZipDeflate, ZipPassThrough, Zip } from "fflate";
import temml from "temml";
import { E } from "./errors";
import type { Env } from "./env";
import type { ProjectRow } from "./authz";
import { sanitizeHtml } from "./sanitize/html";
import { isUuid } from "./util";

export const EXPORT_LIMITS = { nodes: 1000, depth: 10, entries: 2000, textBytes: 64 * 1024 * 1024, binaryBytes: 256 * 1024 * 1024, labelChars: 300, metaChars: 2000 } as const;

export interface TocNode {
  type: "section" | "text";
  label: string;
  textId?: string;
  children: TocNode[];
}

export interface ExportMeta {
  title: string;
  creators: string;
  date: string;
  language: string;
  rights: string;
  description: string;
}

// ---- validation ------------------------------------------------------------

export function parseToc(value: unknown): TocNode[] {
  if (!Array.isArray(value) || value.length === 0) throw E.badRequest("At least one item must be included for export.", "toc_empty");
  let count = 0;
  const walk = (nodes: unknown[], depth: number): TocNode[] => {
    if (depth > EXPORT_LIMITS.depth) throw E.badRequest(`Table of contents nesting is too deep (max ${EXPORT_LIMITS.depth} levels).`, "toc_too_deep");
    return nodes.map((raw) => {
      if (++count > EXPORT_LIMITS.nodes) throw E.badRequest(`The table of contents can hold at most ${EXPORT_LIMITS.nodes} items.`, "toc_too_large");
      const n = raw as { type?: unknown; label?: unknown; textId?: unknown; children?: unknown };
      if (n === null || typeof n !== "object" || (n.type !== "section" && n.type !== "text")) throw E.badRequest("Each item must be a section or a text.", "toc_invalid");
      const label = typeof n.label === "string" ? n.label.trim().slice(0, EXPORT_LIMITS.labelChars) : "";
      if (n.type === "section" && label === "") throw E.badRequest("Sections need a label.", "toc_invalid");
      if (n.type === "text" && (typeof n.textId !== "string" || !isUuid(n.textId))) throw E.badRequest("Text items need a text id.", "toc_invalid");
      if (n.children !== undefined && !Array.isArray(n.children)) throw E.badRequest("children must be a list.", "toc_invalid");
      return { type: n.type, label, ...(n.type === "text" ? { textId: n.textId as string } : {}), children: walk((n.children as unknown[] | undefined) ?? [], depth + 1) };
    });
  };
  return walk(value, 0);
}

export function parseMeta(value: unknown, project: ProjectRow, today: string): ExportMeta {
  const m = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const str = (k: string): string => {
    const v = m[k];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string" || v.length > EXPORT_LIMITS.metaChars) throw E.badRequest(`meta.${k} must be a string of at most ${EXPORT_LIMITS.metaChars} characters.`);
    return v;
  };
  return {
    title: str("title") || project.name,
    creators: str("creators"),
    date: str("date") || today,
    language: str("language") || project.default_language || "en",
    rights: str("rights"),
    description: str("description") || project.description || "",
  };
}

// ---- formatting (legacy helpers, with the YAML fix) ------------------------

export function escapeYaml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, "&quot;");

export function slugify(s: string | null | undefined): string {
  if (!s) return "untitled";
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").substring(0, 60) || "untitled";
}

const decodeTexEntities = (tex: string): string =>
  tex.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

function tex(source: string, displayMode: boolean): string {
  // trust defaults to false: \href, \url, \class, \style and \htmlData are refused.
  return temml.renderToString(decodeTexEntities(source.trim()), { displayMode });
}

/** Legacy convertHtmlTexToMathML, ported: fix mismatched delimiters, then display and inline math. */
export function convertHtmlTexToMathML(input: string): string {
  let html = input;
  const blockClose = /<\/(?:p|section|div|article|table)\b/i;
  html = html.replace(/\\\[([^]*?)\\\)/g, (m, t: string) => (t.length < 500 && !blockClose.test(t) ? `\\[${t}\\]` : m));
  html = html.replace(/\\\(([^]*?)\\\]/g, (m, t: string) => (t.length < 500 && !blockClose.test(t) ? `\\(${t}\\)` : m));
  const anyClose = /<\/(?:p|section|div|article|table|header|footer)\b/i;
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (m, t: string) => {
    if (t.length > 2000 || anyClose.test(t)) return m;
    try { return tex(t, true); } catch { return m; }
  });
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (m, t: string) => {
    if (t.length > 1000 || anyClose.test(t)) return m;
    try { return tex(t, false).replace(/^<math(?!\s+display=)/, '<math display="inline"'); } catch { return m; }
  });
  return html;
}

export function htmlDocument(body: string, title: string, lang: string): string {
  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>`;
}

// ---- planning --------------------------------------------------------------

interface TextInfo {
  id: string;
  name: string;
  html_key: string | null;
  html_bytes: number;
  compiled_key: string | null;
  compiled_bytes: number;
  page_text_bytes: number;
  figure_bytes: number;
  dc_title: string | null;
  dc_language: string | null;
  dc_creator: string | null;
}

export interface ExportPlan {
  project: ProjectRow;
  meta: ExportMeta;
  toc: TocNode[];
  texts: Map<string, TextInfo>;
  figures: Map<string, Map<string, { key: string; bytes: number }>>;
}

const ids = (nodes: TocNode[], out = new Set<string>()): Set<string> => {
  for (const n of nodes) {
    if (n.textId) out.add(n.textId);
    ids(n.children, out);
  }
  return out;
};
const countNodes = (nodes: TocNode[]): number => nodes.reduce((n, x) => n + 1 + countNodes(x.children), 0);

/** Load every row the export needs and check the budget BEFORE anything is streamed. */
export async function planExport(env: Env, project: ProjectRow, toc: TocNode[], meta: ExportMeta): Promise<ExportPlan> {
  const wanted = [...ids(toc)];
  const texts = new Map<string, TextInfo>();
  const figures = new Map<string, Map<string, { key: string; bytes: number }>>();
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    const marks = chunk.map((_, n) => `?${n + 2}`).join(",");
    const rows = await env.DB.prepare(
      `SELECT t.id, t.name, t.html_key, t.html_bytes, t.compiled_key, t.compiled_bytes,
              COALESCE((SELECT SUM(length(CAST(p.ocr_text AS BLOB))) FROM pages p WHERE p.text_id = t.id), 0) AS page_text_bytes,
              COALESCE((SELECT SUM(f.bytes) FROM figures f WHERE f.text_id = t.id), 0) AS figure_bytes,
              m.dc_title, m.dc_language, m.dc_creator
       FROM texts t LEFT JOIN metadata m ON m.text_id = t.id
       WHERE t.project_id = ?1 AND t.id IN (${marks})`,
    ).bind(project.id, ...chunk).all<TextInfo>();
    for (const r of rows.results) texts.set(r.id, r);
    const figs = await env.DB.prepare(`SELECT text_id, filename, image_key, bytes FROM figures WHERE text_id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})`).bind(...chunk).all<{ text_id: string; filename: string; image_key: string; bytes: number }>();
    for (const f of figs.results) {
      if (!figures.has(f.text_id)) figures.set(f.text_id, new Map());
      figures.get(f.text_id)!.set(f.filename, { key: f.image_key, bytes: f.bytes });
    }
  }
  // Same message for a text of another project as for a missing one: nothing is disclosed.
  for (const id of wanted) if (!texts.has(id)) throw E.badRequest("Every text in the table of contents must belong to this project.", "toc_text_unknown");

  let textBytes = 0;
  let binaryBytes = 0;
  const isHtml = project.project_type === "pdf_to_html";
  for (const t of texts.values()) {
    if (isHtml && t.html_key) {
      textBytes += t.html_bytes * 2; // MathML expansion allowance
      binaryBytes += t.figure_bytes; // upper bound: every figure of the text
    } else {
      textBytes += t.compiled_key ? t.compiled_bytes : t.page_text_bytes;
    }
  }
  const nodes = countNodes(toc);
  const imageEntries = isHtml ? [...figures.values()].reduce((n, m) => n + m.size, 0) : 0;
  if (nodes + imageEntries + 1 > EXPORT_LIMITS.entries || textBytes > EXPORT_LIMITS.textBytes || binaryBytes > EXPORT_LIMITS.binaryBytes) {
    throw E.tooLarge("This export is too large to build in one download. Export fewer texts at a time.", "export_too_large");
  }
  return { project, meta, toc, texts, figures };
}

// ---- streaming -------------------------------------------------------------

const CHUNK = 64 * 1024;

/**
 * The ZIP as a stream. Entries are produced one at a time and the producer
 * waits on the stream's backpressure, so memory stays bounded whatever the
 * size of the project. A failure mid-stream aborts the download (the browser
 * sees a failed transfer, never a truncated "successful" ZIP).
 */
export function streamExport(env: Env, plan: ExportPlan, mtime = new Date()): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(undefined, new CountQueuingStrategy({ highWaterMark: 4 }));
  const writer = writable.getWriter();
  let failed = false;
  const zip = new Zip((err, data, final) => {
    if (failed) return;
    if (err) {
      failed = true;
      void writer.abort(err).catch(() => undefined);
      return;
    }
    void writer.write(data).catch(() => undefined);
    if (final) void writer.close().catch(() => undefined);
  });

  const addText = async (name: string, content: string) => {
    const entry = new ZipDeflate(name, { level: 6 });
    entry.mtime = mtime;
    zip.add(entry);
    const bytes = new TextEncoder().encode(content);
    if (bytes.length === 0) entry.push(bytes, true);
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await writer.ready;
      entry.push(bytes.subarray(i, i + CHUNK), i + CHUNK >= bytes.length);
    }
  };
  const addObject = async (name: string, key: string): Promise<boolean> => {
    const obj = await env.FILES.get(key);
    if (!obj) return false; // missing object: skipped, as legacy skipped missing files
    const entry = new ZipPassThrough(name);
    entry.mtime = mtime;
    zip.add(entry);
    const reader = obj.body.getReader();
    for (;;) {
      await writer.ready;
      const { done, value } = await reader.read();
      if (done) break;
      entry.push(value, false);
    }
    entry.push(new Uint8Array(0), true);
    return true;
  };
  const read = async (key: string | null): Promise<string | null> => {
    if (!key) return null;
    const obj = await env.FILES.get(key);
    return obj ? obj.text() : null;
  };

  let counter = 0;
  const { project, meta } = plan;
  interface Entry { label: string; source_path: string; start_section?: true; children?: Entry[] }
  const processNode = async (node: TocNode): Promise<Entry> => {
    counter += 1;
    const num = String(counter).padStart(2, "0");
    let entry: Entry;
    if (node.type === "section") {
      const name = `section-${num}-${slugify(node.label)}.md`;
      await addText(name, ["---", `title: "${escapeYaml(node.label)}"`, "---", "", `# ${node.label}`].join("\n"));
      entry = { label: node.label, source_path: name, start_section: true };
    } else {
      const text = plan.texts.get(node.textId as string) as TextInfo;
      const title = text.dc_title || node.label || text.name || "Untitled";
      const lang = text.dc_language || meta.language;
      const creator = text.dc_creator || meta.creators;
      const html = project.project_type === "pdf_to_html" ? await read(text.html_key) : null;
      if (html) {
        const name = `text-${num}-${slugify(node.label || text.name)}.html`;
        let body = sanitizeHtml(convertHtmlTexToMathML(html));
        const own = plan.figures.get(text.id) ?? new Map<string, { key: string; bytes: number }>();
        const referenced = [...new Set([...body.matchAll(/ src="([^"/]+)"/g)].map((m) => m[1] as string))].filter((f) => own.has(f));
        if (referenced.length > 0) {
          const dir = `images-${num}`;
          for (const f of referenced) await addObject(`${dir}/${f}`, own.get(f)!.key);
          body = body.replace(/ src="([^"/]+)"/g, (m, f: string) => (own.has(f) ? ` src="${dir}/${f}"` : m));
        }
        await addText(name, htmlDocument(body, title, lang));
        entry = { label: title, source_path: name };
      } else {
        let content = await read(text.compiled_key);
        if (content === null) {
          const pages = await env.DB.prepare("SELECT ocr_text FROM pages WHERE text_id = ?1 AND ocr_text IS NOT NULL AND ocr_text != '' ORDER BY page_number, rowid").bind(text.id).all<{ ocr_text: string }>();
          content = pages.results.map((p) => p.ocr_text).join("\n\n---\n\n");
        }
        const name = `text-${num}-${slugify(node.label || text.name)}.md`;
        await addText(name, ["---", `title: "${escapeYaml(title)}"`, `language: "${escapeYaml(lang)}"`, `creator: "${escapeYaml(creator)}"`, "---", "", content].join("\n"));
        entry = { label: title, source_path: name };
      }
    }
    if (node.children.length > 0) {
      entry.children = [];
      for (const child of node.children) entry.children.push(await processNode(child));
    }
    return entry;
  };
  const tocYaml = (e: Entry, indent: number): string[] => {
    const pad = " ".repeat(indent);
    const lines = [`${pad}- label: "${escapeYaml(e.label)}"`, `${pad}  source_path: "${e.source_path}"`];
    if (e.start_section) lines.push(`${pad}  start_section: true`);
    if (e.children?.length) {
      lines.push(`${pad}  children:`);
      for (const c of e.children) lines.push(...tocYaml(c, indent + 4));
    }
    return lines;
  };

  void (async () => {
    try {
      const entries: Entry[] = [];
      for (const node of plan.toc) entries.push(await processNode(node));
      const manifest = [
        "# Manifold Companion Export",
        "",
        "meta:",
        `  title: "${escapeYaml(meta.title)}"`,
        "  creators:",
        ...meta.creators.split(/\s*[,;]\s*/).filter(Boolean).map((c) => `    - name: "${escapeYaml(c.trim())}"`),
        `  date: "${escapeYaml(meta.date)}"`,
        `  language: "${escapeYaml(meta.language)}"`,
        `  rights: "${escapeYaml(meta.rights)}"`,
        `  description: "${escapeYaml(meta.description)}"`,
        "",
        "toc:",
        ...entries.flatMap((e) => tocYaml(e, 2)),
      ];
      await addText("manifest.yml", manifest.join("\n"));
      await writer.ready;
      zip.end();
    } catch (error) {
      failed = true;
      zip.terminate();
      await writer.abort(error).catch(() => undefined);
    }
  })();
  return readable;
}

/** `attachment` with an ASCII fallback name and the UTF-8 original (RFC 6266). */
export function exportFileNames(projectName: string): { ascii: string; utf8: string } {
  return { ascii: `${projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "export"}.zip`, utf8: encodeURIComponent(`${projectName}.zip`) };
}
