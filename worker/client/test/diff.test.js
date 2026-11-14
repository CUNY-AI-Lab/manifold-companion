import { describe, expect, it } from 'vitest';
import { changes, diffLines, splitLines } from '../src/lib/diff.js';

const lcs = (a, b) => {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t[0][0];
};

describe('line diff', () => {
  it('rebuilds both sides and is minimal (random cases against an LCS table)', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 300; n += 1) {
      const a = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'[Math.floor(rnd() * 4)]);
      const b = Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'[Math.floor(rnd() * 4)]);
      const e = diffLines(a, b);
      expect(e.filter((x) => x.type !== 'add').map((x) => x.line)).toEqual(a);
      expect(e.filter((x) => x.type !== 'del').map((x) => x.line)).toEqual(b);
      expect(e.filter((x) => x.type === 'same').length).toBe(lcs(a, b));
    }
  });
  it('splits HTML at block tags so one changed paragraph is one changed line', () => {
    expect(splitLines('<section data-page="1"><p>One</p><p>Two</p></section>')).toEqual(['<section data-page="1">', '<p>One</p>', '<p>Two</p>', '</section>']);
    const c = changes('<p>One</p><p>Two</p>', '<p>One</p><p>Too</p>');
    expect(c).toEqual([{ type: 'same', line: '<p>One</p>' }, { type: 'del', line: '<p>Two</p>' }, { type: 'add', line: '<p>Too</p>' }]);
  });
  it('folds long unchanged runs and reports no changes as empty', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const edited = [...lines]; edited[10] = 'changed';
    const c = changes(lines.join('\n'), edited.join('\n'), 1);
    expect(c[0]).toEqual({ type: 'skip', count: 9 });
    expect(c.filter((x) => x.type === 'del' || x.type === 'add').map((x) => x.line)).toEqual(['line 10', 'changed']);
    expect(c.at(-1)).toEqual({ type: 'skip', count: 8 });
    expect(changes('same\ntext', 'same\ntext')).toEqual([]);
  });
  it('a large rewrite stays fast and falls back to remove-all, add-all', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 5000 }, (_, i) => `b${i}`);
    const t = Date.now();
    const e = diffLines(a, b);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(e.filter((x) => x.type === 'del')).toHaveLength(5000);
  });
});
