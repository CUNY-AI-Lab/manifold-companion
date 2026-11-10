import { describe, expect, it } from 'vitest';
import { isRangeAnchor, locate, makeAnchor } from '../src/lib/anchor.js';

const text = 'The quick brown fox jumps over the lazy dog. The quick brown cat sleeps.';

describe('range anchors', () => {
  it('captures the quote, context and position; refuses an empty or blank selection', () => {
    const a = makeAnchor(text, 4, 15, 'p1');
    expect(a).toEqual({ quote: 'quick brown', prefix: 'The ', suffix: ' fox jumps over the lazy dog. Th', start: 4, end: 15, page_id: 'p1' });
    expect(makeAnchor(text, 3, 4)).toBeNull();
    expect(makeAnchor(text, 9, 9)).toBeNull();
  });
  it('finds the quote again after edits before it, and picks the occurrence whose context matches', () => {
    const a = makeAnchor(text, 45, 60); // the second "The quick brown"
    expect(locate(a, text)).toEqual({ start: 45, end: 60 });
    const edited = `Preface. ${text}`;
    expect(locate(a, edited)).toEqual({ start: 54, end: 69 });
    const first = makeAnchor(text, 4, 15);
    expect(locate(first, `Preface. ${text}`)).toEqual({ start: 13, end: 24 });
  });
  it('is detached when the quote is gone, or when two equally good places remain', () => {
    const a = makeAnchor(text, 16, 19); // "fox"
    expect(locate(a, text.replace('fox', 'wolf'))).toBeNull();
    const twin = makeAnchor('ab X cd ab X cd', 3, 4);
    expect(locate({ ...twin, prefix: 'zz', suffix: 'yy', start: 99 }, 'ab X cd ab X cd')).toBeNull();
  });
  it('treats anything that is not a range anchor as detached', () => {
    for (const bad of [null, {}, { quote: '' }, { quote: 'x', prefix: 1 }, '<img src=x onerror=alert(1)>']) {
      expect(isRangeAnchor(bad)).toBe(false);
      expect(locate(bad, text)).toBeNull();
    }
  });
});
