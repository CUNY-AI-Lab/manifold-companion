import { describe, expect, it } from 'vitest';
import { splitGroups } from '../src/lib/split.js';

describe('split groups', () => {
  it('runs of pages starting at the given page numbers; junk, duplicates, 1 and out-of-range numbers are ignored', () => {
    expect(splitGroups('4, 9', 10)).toEqual([[1, 2, 3], [4, 5, 6, 7, 8], [9, 10]]);
    expect(splitGroups('9,4,4, x, 1, 11, 0', 10)).toEqual([[1, 2, 3], [4, 5, 6, 7, 8], [9, 10]]);
    expect(splitGroups('', 5)).toEqual([[1, 2, 3, 4, 5]]);
    expect(splitGroups('2', 2)).toEqual([[1], [2]]);
  });
});
