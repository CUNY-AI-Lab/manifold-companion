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

export function postprocessPageHtml(html: string, pageNumber: number): string {
  let result = html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/\s+style="[^"]*"/gi, "");
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

export function cleanupDocumentHtml(html: string): string {
  const normalized = html.replace(/(<section[^>]*data-page[^>]*>)([\s\S]*?)(<\/section>)/gi, (_m, open: string, inner: string, close: string) => open + wrapOrphanedHeaders(inner) + close);
  return /<article\b/i.test(normalized) ? normalized : `<article class="pdf-html-document">\n${normalized}\n</article>`;
}

export function toDataUri(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}
