import { describe, expect, it } from 'vitest';
import { fetchAllTexts, pageCount, pageFromSearch, rangeLabel } from '../src/lib/paging.js';

describe('text list paging', () => {
  it('counts pages, reads ?page= and labels the range', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(50)).toBe(1);
    expect(pageCount(51)).toBe(2);
    expect(pageCount(123)).toBe(3);
    expect(pageFromSearch('?page=2', 3)).toBe(2);
    expect(pageFromSearch('?page=9', 3)).toBe(3);
    expect(pageFromSearch('?page=0')).toBe(1);
    expect(pageFromSearch('?page=abc')).toBe(1);
    expect(pageFromSearch('')).toBe(1);
    expect(rangeLabel(1, 123)).toBe('Texts 1–50 of 123');
    expect(rangeLabel(3, 123)).toBe('Texts 101–123 of 123');
    expect(rangeLabel(1, 0)).toBe('No texts');
  });

  it('fetches every text across pages for the export', async () => {
    const all = Array.from({ length: 123 }, (_, i) => ({ id: `t${i}` }));
    const calls = [];
    const api = { get: async (url) => { calls.push(url); const page = Number(/page=(\d+)/.exec(url)[1]); return { texts: all.slice((page - 1) * 50, page * 50), total: all.length }; } };
    expect(await fetchAllTexts(api, 'p')).toEqual(all);
    expect(calls).toEqual(['/api/projects/p/texts?limit=50&page=1', '/api/projects/p/texts?limit=50&page=2', '/api/projects/p/texts?limit=50&page=3']);
  });
});
