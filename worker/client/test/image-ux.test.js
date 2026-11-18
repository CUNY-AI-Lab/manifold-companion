import { describe, expect, it } from 'vitest';
import { joinPageTexts } from '../src/lib/tasks.js';

describe('the source an image text exports', () => {
  const pages = [{ ocr_text: 'one' }, { ocr_text: null }, { ocr_text: 'two' }];
  it('joins the page texts as the export does, skipping empty pages', () => {
    expect(joinPageTexts(pages)).toBe('one\n\ntwo');
  });
});

import { clampPan, clampZoom, MAX_ZOOM, panAfterZoom, zoomStep } from '../src/lib/zoom.js';

describe('scan zoom and pan', () => {
  it('steps between 100% and 500%, snapping back to 100%', () => {
    expect(zoomStep(1, 'in')).toBe(1.25);
    expect(zoomStep(1.25, 'out')).toBe(1);
    expect(zoomStep(1, 'out')).toBe(1);
    let z = 1;
    for (let i = 0; i < 20; i += 1) z = zoomStep(z, 'in');
    expect(z).toBe(MAX_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
  });
  it('a fitted scan cannot move; a zoomed one moves at most (z-1)/2 of its box', () => {
    expect(clampPan({ x: 50, y: -50 }, 1, 400, 600)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 500, y: -500 }, 2, 400, 600)).toEqual({ x: 200, y: -300 });
  });
  it('zooming keeps the point under the centre, and zooming out pulls the scan back in', () => {
    expect(panAfterZoom({ x: 100, y: 40 }, 2, 4, 400, 600)).toEqual({ x: 200, y: 80 });
    expect(panAfterZoom({ x: 200, y: 0 }, 2, 1, 400, 600)).toEqual({ x: 0, y: 0 });
  });
});

import { LANGUAGE_CODES, languageName, languageOptions } from '../../src/languages.ts';

describe('languages', () => {
  it('menus show names, English first; Ancient Greek and Yiddish are back', () => {
    const opts = languageOptions();
    expect(opts[0]).toEqual({ code: 'en', name: 'English' });
    expect(opts.find((o) => o.code === 'grc')?.name).toBe('Ancient Greek');
    expect(opts.find((o) => o.code === 'yi')?.name).toBe('Yiddish');
    const rest = opts.slice(1).map((o) => o.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });
  it('the routes accept every menu code plus auto-detect; prompts get names', () => {
    for (const o of languageOptions()) expect(LANGUAGE_CODES.has(o.code)).toBe(true);
    expect(LANGUAGE_CODES.has('auto-detect')).toBe(true);
    expect(LANGUAGE_CODES.has('klingon')).toBe(false);
    expect(languageName('grc')).toBe('Ancient Greek');
    expect(languageName('auto-detect')).toMatch(/detect/);
    expect(languageName('xx')).toBe('xx');
  });
});

import { applyEdit, formatMarkdown } from '../src/lib/markdown-format.js';

describe('Markdown toolbar', () => {
  const run = (value, start, end, action) => { const e = formatMarkdown(value, start, end, action); return { out: applyEdit(value, e), sel: value === undefined ? null : [e.selStart, e.selEnd] }; };
  it('bold and italic wrap the selection, leave a trailing space outside, and unwrap again', () => {
    expect(run('Cara mamma', 0, 4, 'bold')).toEqual({ out: '**Cara** mamma', sel: [2, 6] });
    expect(run('Cara mamma', 0, 5, 'bold').out).toBe('**Cara** mamma');
    expect(run('**Cara** mamma', 2, 6, 'bold').out).toBe('Cara mamma');
    expect(run('**Cara** mamma', 0, 8, 'bold').out).toBe('Cara mamma');
    expect(run('Cara mamma', 5, 10, 'italic').out).toBe('Cara *mamma*');
    expect(run('Cara *mamma*', 6, 11, 'italic').out).toBe('Cara mamma');
    // Italic inside bold is added, not mistaken for bold's markers.
    expect(run('**Cara**', 2, 6, 'italic').out).toBe('***Cara***');
  });
  it('with nothing selected, the markers go in with the cursor between them', () => {
    const e = formatMarkdown('ab', 1, 1, 'bold');
    expect(applyEdit('ab', e)).toBe('a****b');
    expect([e.selStart, e.selEnd]).toEqual([3, 3]);
  });
  it('headings set, change or remove the level of every selected line', () => {
    expect(run('Title\nbody', 2, 2, 'h1').out).toBe('# Title\nbody');
    expect(run('# Title\nbody', 2, 2, 'h2').out).toBe('## Title\nbody');
    expect(run('## Title\nbody', 3, 3, 'h2').out).toBe('Title\nbody');
    expect(run('one\ntwo\nthree', 0, 7, 'h3').out).toBe('### one\n### two\nthree');
  });
  it('quote prefixes every selected line, or removes the prefix when all have it', () => {
    expect(run('one\ntwo', 0, 7, 'quote').out).toBe('> one\n> two');
    expect(run('> one\n> two', 0, 11, 'quote').out).toBe('one\ntwo');
  });
  it('a separator goes on its own line after the current one', () => {
    expect(run('para one\npara two', 3, 3, 'separator').out).toBe('para one\n\n---\n\npara two');
    expect(run('para\n', 5, 5, 'separator').out).toBe('para\n---\n');
  });
});

import { fitWithin, makeQueue } from '../src/lib/thumbs.js';

describe('page thumbnails', () => {
  it('fit within the edge without enlarging', () => {
    expect(fitWithin(2048, 1536, 96)).toEqual({ width: 96, height: 72 });
    expect(fitWithin(1000, 3000, 96)).toEqual({ width: 32, height: 96 });
    expect(fitWithin(50, 40, 96)).toEqual({ width: 50, height: 40 });
  });
  it('are made a few at a time, in order', async () => {
    const run = makeQueue(2);
    let active = 0;
    let peak = 0;
    const order = [];
    const job = (n) => () => new Promise((r) => { active += 1; peak = Math.max(peak, active); setTimeout(() => { active -= 1; order.push(n); r(n); }, 5); });
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => run(job(n))));
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(order.slice(0, 2).sort()).toEqual([1, 2]);
    // A failing job does not stop the queue.
    await expect(run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await run(() => 7)).toBe(7);
  });
});

import { describeCounts, findFlags, flagCounts, markFlagsInHtml, stepFlag } from '../src/lib/flags.js';

describe('uncertain readings', () => {
  const page = 'Cara [unclear: mamma], siamo [illegible] a [damaged: Nap] e [deleted: ieri] [handwritten: oggi] [inserted: qui] [annotation: in pencil]. [note: not a flag]';
  it('finds every kind the prompts write, with positions, and nothing else', () => {
    const flags = findFlags(page);
    expect(flags.map((f) => f.kind)).toEqual(['unclear', 'illegible', 'damaged', 'deleted', 'handwritten', 'inserted', 'annotation']);
    expect(page.slice(flags[0].start, flags[0].end)).toBe('[unclear: mamma]');
    expect(flags[0].body).toBe('mamma');
    expect(flags[1].body).toBe('');
    expect(findFlags('[unclear: a\nb]')).toEqual([]);
  });
  it('counts doubts apart from editorial marks', () => {
    const c = flagCounts(page);
    expect(c).toMatchObject({ total: 7, doubts: 3 });
    expect(describeCounts(c)).toBe('1 unclear, 1 illegible, 1 damaged, 1 deleted, 1 handwritten, 1 inserted, 1 annotation');
  });
  it('steps to the next and previous flag, across pages, from the caret', () => {
    const pages = [{ text: 'a [unclear: x] b [illegible]' }, { text: 'none here' }, { text: '[damaged: y] c' }];
    expect(stepFlag(pages, { pageIndex: 0, offset: 0 }, 1)).toMatchObject({ pageIndex: 0, flag: { kind: 'unclear' } });
    expect(stepFlag(pages, { pageIndex: 0, offset: 2 }, 1)).toMatchObject({ pageIndex: 0, flag: { kind: 'illegible' } });
    expect(stepFlag(pages, { pageIndex: 0, offset: 20 }, 1)).toMatchObject({ pageIndex: 2, flag: { kind: 'damaged' } });
    expect(stepFlag(pages, { pageIndex: 2, offset: 0 }, -1)).toMatchObject({ pageIndex: 0, flag: { kind: 'illegible' } });
    expect(stepFlag(pages, { pageIndex: 0, offset: 17 }, -1)).toMatchObject({ pageIndex: 0, flag: { kind: 'unclear' } });
    expect(stepFlag(pages, { pageIndex: 2, offset: 14 }, 1)).toBeNull();
  });
  it('marks flags in preview HTML text, never inside a tag or attribute', () => {
    expect(markFlagsInHtml('<p>a [unclear: b] c</p>')).toBe('<p>a <mark>[unclear: b]</mark> c</p>');
    expect(markFlagsInHtml('<img alt="[unclear: b]"><p>[illegible]</p>')).toBe('<img alt="[unclear: b]"><p><mark>[illegible]</mark></p>');
    expect(markFlagsInHtml('<p>[unclear: &lt;b&gt;]</p>')).toBe('<p><mark>[unclear: &lt;b&gt;]</mark></p>');
  });
});
