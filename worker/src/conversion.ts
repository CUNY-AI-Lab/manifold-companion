// The resume store of a PDF conversion in progress (migration 0012). The browser
// converts one page per request; each converted page is kept here, keyed to the
// PDF it came from, so a reload resumes instead of paying again. Bounded: a page
// is kept only while the run's page count is within the project page cap and
// its HTML within CONVERSION_PAGE_MAX_BYTES; a page that does not fit is simply
// not kept (the run still has it in memory). Rows are a cache: never exported,
// never counted as content, deleted when the conversion is saved.
import { byteLength } from "./content";
import { nowIso } from "./util";

export const CONVERSION_PAGE_MAX_BYTES = 64 * 1024;
export const CONVERSION_MAX_AGE_DAYS = 7;
const SOURCE = /^[A-Za-z0-9._:-]{1,200}$/;

export const validSource = (s: unknown): s is string => typeof s === "string" && SOURCE.test(s);

/** Keep one converted page. Pages of another PDF are dropped first, so a run never mixes two sources. Returns whether it was kept. */
export async function keepConvertedPage(db: D1Database, textId: string, page: { source: string; pageNumber: number; totalPages: number; math: boolean; html: string; warnings: string[]; model: string }, maxPages: number): Promise<boolean> {
  if (page.totalPages > maxPages || page.pageNumber > page.totalPages || byteLength(page.html) > CONVERSION_PAGE_MAX_BYTES) return false;
  await db.batch([
    db.prepare("DELETE FROM conversion_pages WHERE text_id = ?1 AND (source != ?2 OR total_pages != ?3)").bind(textId, page.source, page.totalPages),
    db.prepare(
      `INSERT INTO conversion_pages (text_id, page_number, source, total_pages, math, html, warnings, model, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM texts WHERE id = ?1)
       ON CONFLICT (text_id, page_number) DO UPDATE SET source = excluded.source, total_pages = excluded.total_pages, math = excluded.math, html = excluded.html, warnings = excluded.warnings, model = excluded.model, created_at = excluded.created_at`,
    ).bind(textId, page.pageNumber, page.source, page.totalPages, page.math ? 1 : 0, page.html, JSON.stringify(page.warnings.slice(0, 20)), page.model, nowIso()),
  ]);
  return true;
}

export interface ConvertedPage { page_number: number; total_pages: number; math: boolean; html: string; warnings: string[]; model: string | null; created_at: string }

/** The kept pages of the run from this PDF, oldest first; none when the store holds another PDF's pages. */
export async function convertedPages(db: D1Database, textId: string, source: string, nowMs = Date.now()): Promise<ConvertedPage[]> {
  const rows = await db.prepare("SELECT page_number, total_pages, math, html, warnings, model, created_at FROM conversion_pages WHERE text_id = ?1 AND source = ?2 AND created_at >= ?3 ORDER BY page_number")
    .bind(textId, source, nowIso(nowMs - CONVERSION_MAX_AGE_DAYS * 86_400_000)).all<{ page_number: number; total_pages: number; math: number; html: string; warnings: string; model: string | null; created_at: string }>();
  return rows.results.map((r) => {
    let warnings: string[] = [];
    try { const w = JSON.parse(r.warnings); if (Array.isArray(w)) warnings = w.filter((x) => typeof x === "string"); } catch { /* none */ }
    return { ...r, math: r.math === 1, warnings };
  });
}

/** What is kept, without the pages: the PDF it is from, how many pages of how many, and when the last was kept. */
export async function conversionRun(db: D1Database, textId: string, nowMs = Date.now()): Promise<{ source: string; kept: number; total_pages: number; updated_at: string } | null> {
  const row = await db.prepare("SELECT source, COUNT(*) AS kept, MAX(total_pages) AS total_pages, MAX(created_at) AS updated_at FROM conversion_pages WHERE text_id = ?1 AND created_at >= ?2 GROUP BY source ORDER BY updated_at DESC LIMIT 1")
    .bind(textId, nowIso(nowMs - CONVERSION_MAX_AGE_DAYS * 86_400_000)).first<{ source: string; kept: number; total_pages: number; updated_at: string }>();
  return row ?? null;
}

export const clearConversion = (db: D1Database, textId: string) => db.prepare("DELETE FROM conversion_pages WHERE text_id = ?1").bind(textId);

/** Retention: runs left for more than CONVERSION_MAX_AGE_DAYS are dropped. */
export async function sweepConversions(db: D1Database, nowMs = Date.now()): Promise<number> {
  const r = await db.prepare("DELETE FROM conversion_pages WHERE created_at < ?1").bind(nowIso(nowMs - CONVERSION_MAX_AGE_DAYS * 86_400_000)).run();
  return r.meta.changes ?? 0;
}
