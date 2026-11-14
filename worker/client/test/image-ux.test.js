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
