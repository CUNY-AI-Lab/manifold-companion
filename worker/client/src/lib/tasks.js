// Client-driven model work. The Worker does one unit per request; these loops
// run in the page, one request at a time, with a visible Cancel, and stop at
// the first error that more requests would not fix.
import { api } from '../api/client';
import { blobToDataUri } from './image';
import { openPdf, pageTextHint, renderPage } from './pdf';

/** Errors that end a whole run: spending more would not help, or the person must act. */
export function stopsRun(error) {
  if (error?.name === 'AbortError') return true;
  return ['quota_exceeded', 'catalog_unavailable', 'no_model_available', 'model_not_allowed', 'authentication_required', 'session_invalid', 'invalid_credential', 'insufficient_role'].includes(error?.code) || error?.status === 429 || error?.status === 503;
}

/** OCR the given pages one by one. Returns per-page outcomes; never retries on its own. */
export async function runOcr({ textId, pages, overwrite = false, model, signal, onPage }) {
  const outcomes = [];
  for (const [index, page] of pages.entries()) {
    if (signal?.aborted) break;
    onPage?.({ index, page, state: 'running' });
    try {
      const result = await api.post(`/api/texts/${textId}/pages/${page.id}/ocr`, { overwrite, ...(model ? { model } : {}) }, { signal });
      outcomes.push({ page, ok: true, text: result.text });
      onPage?.({ index, page, state: 'done', text: result.text });
    } catch (error) {
      outcomes.push({ page, ok: false, error });
      onPage?.({ index, page, state: 'failed', error });
      if (stopsRun(error)) break;
    }
  }
  return outcomes;
}

/** Split text into chunks of at most `max` characters on paragraph, then sentence, boundaries. */
export function chunkText(text, max = 10000) {
  const chunks = [];
  let current = '';
  const push = () => { if (current.trim()) chunks.push(current); current = ''; };
  for (const para of text.split(/\n{2,}/)) {
    const pieces = para.length <= max ? [para] : para.match(new RegExp(`[^]{1,${max}}(?=\\s|$)|[^]{1,${max}}`, 'g'));
    for (const piece of pieces) {
      if (current && current.length + 2 + piece.length > max) push();
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  push();
  return chunks;
}

/** Translate chunk by chunk, then store the assembled translation. */
export async function translateText({ textId, text, source, target, model, signal, onProgress }) {
  const chunks = chunkText(text);
  const out = [];
  for (const [i, chunk] of chunks.entries()) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onProgress?.({ done: i, total: chunks.length });
    const r = await api.post(`/api/texts/${textId}/translate-chunk`, { text: chunk, source_language: source, target_language: target, ...(model ? { model } : {}) }, { signal });
    out.push(r.text);
  }
  onProgress?.({ done: chunks.length, total: chunks.length });
  const translation = out.join('\n\n');
  await api.put(`/api/texts/${textId}/translation`, { translation, source_language: source, target_language: target });
  return translation;
}

/**
 * PDF to HTML: each page rendered with pdf.js and sent as an image, one page
 * per request, math/table pages to the separate math model. Pages already
 * converted are kept if the run stops, so a person can resume.
 */
export async function convertPdf({ textId, file, mathPages = new Set(), allMath = false, model, mathModel, signal, onProgress, done = new Map(), warnings = new Map() }) {
  const pdf = await openPdf(file);
  const total = pdf.numPages;
  for (let n = 1; n <= total; n += 1) {
    if (done.has(n)) continue;
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const math = allMath || mathPages.has(n);
    onProgress?.({ stage: 'render', page: n, total });
    const { blob } = await renderPage(pdf, n, { math });
    const image = await blobToDataUri(blob);
    const text_hint = await pageTextHint(pdf, n);
    onProgress?.({ stage: 'convert', page: n, total, math });
    const r = await api.post(`/api/texts/${textId}/parse-page`, { image, page_number: n, total_pages: total, text_hint, math, ...(math ? (mathModel ? { model: mathModel } : {}) : model ? { model } : {}) }, { signal });
    done.set(n, r.html);
    if (r.warnings?.length) warnings.set(n, r.warnings);
  }
  onProgress?.({ stage: 'assemble', page: total, total });
  const assembled = `<article class="pdf-html-document">\n${[...done.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h).join('\n')}\n</article>`;
  const { html } = await api.post(`/api/texts/${textId}/html/cleanup`, { html: assembled }, { signal });
  await api.put(`/api/texts/${textId}/html`, { html_content: html, pdf_meta: { file_name: file.name, page_count: total, math_pages: allMath ? 'all' : [...mathPages], generated_at: new Date().toISOString() } });
  return { html, total, warnings };
}

const CHECKS = {
  figure_values: 'a figure description states points or values read off a graph. Models often misread graphs: compare it with the page, or replace it with a short description.',
  numbering_restarted: 'a numbered list starts again at 1, but the page prints other numbers. Add start="..." to the <ol>, or write the numbers in the text.',
};

/** Page warnings from the conversion, one line per page and kind. */
export function checkList(warnings) {
  return [...warnings.entries()].sort((a, b) => a[0] - b[0]).flatMap(([page, kinds]) => kinds.filter((k) => CHECKS[k]).map((k) => `Page ${page}: ${CHECKS[k]}`));
}
