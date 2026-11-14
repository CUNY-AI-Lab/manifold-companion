import { describe, expect, it } from 'vitest';
import { MIN_PAGE_BYTES, pdfFileProblem, pdfPagesProblem } from '../src/lib/limits.js';

describe('PDF preflight', () => {
  const base = { name: 'book.pdf', maxPages: 300, usedBytes: 0, quotaBytes: 500 * 1024 * 1024 };
  it('refuses a PDF with more pages than the project has room for, before anything is drawn', () => {
    expect(pdfPagesProblem({ ...base, pdfPages: 40, pageCount: 270 })).toMatch(/book\.pdf has 40 pages, and this project has room for 30 more \(a project holds at most 300 pages\)/);
    expect(pdfPagesProblem({ ...base, pdfPages: 30, pageCount: 270 })).toBeNull();
    expect(pdfPagesProblem({ ...base, pdfPages: 1, pageCount: 300 })).toMatch(/room for 0 more/);
  });
  it('refuses only when even small page images certainly would not fit the free storage', () => {
    expect(pdfPagesProblem({ ...base, pdfPages: 10, pageCount: 0, usedBytes: base.quotaBytes - 10 * MIN_PAGE_BYTES + 1 })).toMatch(/of your storage is free/);
    expect(pdfPagesProblem({ ...base, pdfPages: 10, pageCount: 0, usedBytes: base.quotaBytes - 10 * MIN_PAGE_BYTES })).toBeNull();
    expect(pdfPagesProblem({ ...base, pdfPages: 10, pageCount: 0, quotaBytes: Infinity })).toBeNull();
  });
  it('a source PDF over the size limit or the free storage is refused before the upload', () => {
    expect(pdfFileProblem({ name: 'a.pdf', bytes: 60e6, maxPdfBytes: 50e6, usedBytes: 0, quotaBytes: 1e9 })).toMatch(/can be at most/);
    expect(pdfFileProblem({ name: 'a.pdf', bytes: 2e6, maxPdfBytes: 50e6, usedBytes: 999e6, quotaBytes: 1e9 })).toMatch(/of your storage is free/);
    expect(pdfFileProblem({ name: 'a.pdf', bytes: 2e6, maxPdfBytes: 50e6, usedBytes: 0, quotaBytes: Infinity })).toBeNull();
  });
});
