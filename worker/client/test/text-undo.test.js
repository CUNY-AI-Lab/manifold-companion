import { describe, expect, it } from 'vitest';
import { COALESCE_MS, isRedoKey, isUndoKey, record, startHistory, step, UNDO_LIMIT } from '../src/lib/text-undo.js';

const typeAll = (h, values, t0 = 1000, gap = 100) => values.reduce((acc, v, i) => record(acc, v, [v.length, v.length], t0 + i * gap, 'type'), h);

describe('text undo history', () => {
  it('a burst of typing is one step; a pause starts another', () => {
    let h = typeAll(startHistory('Cara'), ['Cara ', 'Cara m', 'Cara ma']);
    expect(h.entries.map((e) => e.value)).toEqual(['Cara', 'Cara ma']);
    h = record(h, 'Cara mam', [8, 8], 1000 + 200 + COALESCE_MS, 'type');
    expect(h.entries.map((e) => e.value)).toEqual(['Cara', 'Cara ma', 'Cara mam']);
  });

  it('a toolbar edit is always its own step, and typing after it starts a new one', () => {
    let h = typeAll(startHistory('Cara mamma'), ['Cara mammaX']);
    h = record(h, '**Cara** mammaX', [0, 8], 1150, 'format');
    h = record(h, '**Cara** mammaXY', [16, 16], 1200, 'type');
    expect(h.entries.map((e) => e.value)).toEqual(['Cara mamma', 'Cara mammaX', '**Cara** mammaX', '**Cara** mammaXY']);
  });

  it('undo and redo walk the steps with their selections, and stop at either end', () => {
    let h = record(record(startHistory('a'), 'ab', [2, 2], 1000, 'format'), 'abc', [3, 3], 1100, 'format');
    let entry;
    [h, entry] = step(h, -1); expect(entry).toEqual({ value: 'ab', sel: [2, 2] });
    [h, entry] = step(h, -1); expect(entry.value).toBe('a');
    [h, entry] = step(h, -1); expect(entry).toBeNull();
    [h, entry] = step(h, 1); expect(entry.value).toBe('ab');
    [h, entry] = step(h, 1); expect(entry.value).toBe('abc');
    [h, entry] = step(h, 1); expect(entry).toBeNull();
  });

  it('an edit after an undo drops what could have been redone, and is never merged into the step undone to', () => {
    let h = typeAll(startHistory(''), ['x']);
    h = record(h, 'xy', [2, 2], 5000, 'type');
    [h] = step(h, -1);
    h = record(h, 'xz', [2, 2], 5050, 'type');
    expect(h.entries.map((e) => e.value)).toEqual(['', 'x', 'xz']);
    expect(step(h, 1)[1]).toBeNull();
  });

  it('the starting text is never overwritten by typing, and an unchanged value records nothing', () => {
    const start = startHistory('page');
    expect(record(start, 'page', [0, 0], 1, 'type')).toBe(start);
    const h = typeAll(start, ['page!', 'page!!']);
    expect(h.entries[0].value).toBe('page');
  });

  it('keeps at most UNDO_LIMIT steps', () => {
    let h = startHistory('');
    for (let i = 1; i <= UNDO_LIMIT + 50; i += 1) h = record(h, 'x'.repeat(i), [i, i], i * 10_000, 'format');
    expect(h.entries).toHaveLength(UNDO_LIMIT);
    expect(h.entries.at(-1).value).toHaveLength(UNDO_LIMIT + 50);
  });

  it('knows the undo and redo keys of every platform, and nothing else', () => {
    const k = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
    expect(isUndoKey(k('z', { metaKey: true }))).toBe(true);
    expect(isUndoKey(k('z', { ctrlKey: true }))).toBe(true);
    expect(isUndoKey(k('Z', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isUndoKey(k('z'))).toBe(false);
    expect(isUndoKey(k('z', { metaKey: true, altKey: true }))).toBe(false);
    expect(isRedoKey(k('Z', { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isRedoKey(k('z', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isRedoKey(k('y', { ctrlKey: true }))).toBe(true);
    expect(isRedoKey(k('y', { metaKey: true }))).toBe(false);
    expect(isRedoKey(k('z', { metaKey: true }))).toBe(false);
  });
});
