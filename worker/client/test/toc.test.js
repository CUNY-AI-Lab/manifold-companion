import { describe, expect, it } from 'vitest';
import * as toc from '../src/lib/toc.js';

const texts = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];

describe('table of contents (flat with depths, sent nested)', () => {
  it('nests by depth as the legacy panel did; a jump of two levels nests under the nearest shallower item', () => {
    const items = [{ type: 'section', label: 'Part', depth: 0 }, { type: 'text', label: 'A', textId: 'a', depth: 1 }, { type: 'text', label: 'B', textId: 'b', depth: 3 }, { type: 'text', label: 'C', textId: 'c', depth: 0 }];
    expect(toc.flatToNested(items)).toEqual([
      { type: 'section', label: 'Part', children: [{ type: 'text', label: 'A', textId: 'a', children: [{ type: 'text', label: 'B', textId: 'b', children: [] }] }] },
      { type: 'text', label: 'C', textId: 'c', children: [] },
    ]);
  });
  it('reconciles a saved list with the texts now: deleted texts drop, new ones append, duplicates and bad items go', () => {
    const saved = [{ id: 4, type: 'section', label: 'Part', depth: 0 }, { id: 5, type: 'text', textId: 'gone', label: 'Gone', depth: 1 }, { id: 6, type: 'text', textId: 'b', label: 'B (renamed here)', depth: 9 }, { id: 7, type: 'text', textId: 'b', label: 'dup', depth: 0 }, { type: 'section', label: '  ' }, null];
    const out = toc.reconcileToc(saved, texts);
    expect(out.map((i) => [i.id, i.type, i.label, i.depth, i.textId ?? null])).toEqual([[1, 'section', 'Part', 0, null], [2, 'text', 'B (renamed here)', 5, 'b'], [3, 'text', 'A', 0, 'a'], [4, 'text', 'C', 0, 'c']]);
    expect(toc.reconcileToc(undefined, texts).map((i) => i.textId)).toEqual(['a', 'b', 'c']);
    // A text the person removed stays out; a text created after the save is appended.
    const kept = toc.reconcileToc([{ type: 'text', textId: 'a', label: 'A', depth: 0 }], [...texts, { id: 'd', name: 'D' }], ['b', 'c']);
    expect(kept.map((i) => i.textId)).toEqual(['a', 'd']);
    expect(toc.excludedIds(kept, texts)).toEqual(['b', 'c']);
  });
  it('edits are bounded: depth 0..5, moves inside the list, labels at most 200, one entry per text, at most 500 items', () => {
    let items = toc.reconcileToc([], texts);
    items = toc.indent(items, 1, 9);
    expect(items[1].depth).toBe(toc.MAX_DEPTH);
    expect(toc.indent(items, 0, -1)[0].depth).toBe(0);
    expect(toc.move(items, 0, -1)).toBe(items);
    expect(toc.move(items, 0, 1).map((i) => i.textId)).toEqual(['b', 'a', 'c']);
    expect(toc.addText(items, texts[0])).toBe(items);
    items = toc.addSection(items, 'x'.repeat(300));
    expect(items.at(-1)).toMatchObject({ type: 'section', label: 'x'.repeat(200), id: 4 });
    expect(toc.addSection(items, '   ')).toBe(items);
    expect(toc.remove(items, 0).map((i) => i.id)).toEqual([2, 3, 4]);
    let many = [];
    for (let n = 0; n < 600; n += 1) many = toc.addSection(many, `s${n}`);
    expect(many).toHaveLength(toc.MAX_ITEMS);
  });
});
