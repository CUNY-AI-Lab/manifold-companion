import { describe, expect, it } from 'vitest';
import { exportSource, joinPageTexts } from '../src/lib/tasks.js';

describe('the source an image text exports and translates', () => {
  const pages = [{ ocr_text: 'one' }, { ocr_text: null }, { ocr_text: 'two' }];
  it('joins the page texts as the export does, skipping empty pages', () => {
    expect(joinPageTexts(pages)).toBe('one\n\n---\n\ntwo');
  });
  it('uses the edited full text once one is saved', async () => {
    const asked = [];
    const get = async (path) => { asked.push(path); return { text: 'edited whole text' }; };
    expect(await exportSource({ textId: 't1', hasCompiled: true, pages, get })).toEqual({ text: 'edited whole text', from: 'fulltext' });
    expect(asked).toEqual(['/api/texts/t1/compiled']);
  });
  it('uses the pages when no full text is saved, without asking the server', async () => {
    const get = async () => { throw new Error('not called'); };
    expect(await exportSource({ textId: 't1', hasCompiled: false, pages, get })).toEqual({ text: 'one\n\n---\n\ntwo', from: 'pages' });
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
