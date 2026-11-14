import { describe, expect, it } from 'vitest';
import { saveFromBase, staleSaveQuestion } from '../src/lib/stale-save.js';

const conflict = (result) => Object.assign(new Error('Someone saved this after you opened it.'), { code: 'edit_conflict', status: 409, result });

describe('stale saves', () => {
  it('sends the loaded rev; a clean save is returned as is', async () => {
    const sent = [];
    const r = await saveFromBase({ send: async (b) => { sent.push(b); return { rev: 'r2' }; }, base: 'r1', confirm: async () => { throw new Error('not asked'); }, what: 'the HTML' });
    expect(r).toEqual({ rev: 'r2' });
    expect(sent).toEqual(['r1']);
  });

  it('a refused save asks; replacing sends again on the current rev', async () => {
    const sent = [];
    let asked = null;
    const send = async (b) => { sent.push(b); if (b === 'old') throw conflict({ rev: 'theirs', saved_by: 'Bob', saved_at: '2026-11-14T10:00:00.000Z' }); return { rev: 'mine' }; };
    const r = await saveFromBase({ send, base: 'old', confirm: async (q) => { asked = q; return true; }, what: 'page 3' });
    expect(r).toEqual({ rev: 'mine' });
    expect(sent).toEqual(['old', 'theirs']);
    expect(asked.title).toBe('Page 3 was saved by someone else');
    expect(asked.message).toMatch(/^Bob saved page 3 at .+, after you opened it\./);
    expect(asked.message).toMatch(/version history/);
  });

  it('keeping editing saves nothing and says so; other errors pass through', async () => {
    const send = async () => { throw conflict({ rev: 'theirs', saved_by: null, saved_at: null }); };
    await expect(saveFromBase({ send, base: 'old', confirm: async () => false, what: 'the full text' })).rejects.toThrow(/^Not saved: someone else saved the full text/);
    const other = Object.assign(new Error('quota'), { code: 'storage_quota_exceeded' });
    await expect(saveFromBase({ send: async () => { throw other; }, base: 'x', confirm: async () => true, what: 'x' })).rejects.toBe(other);
  });

  it('an unversioned kind warns that theirs is not kept', () => {
    expect(staleSaveQuestion({ saved_by: null }, 'the translation', { history: false }).message).toMatch(/^Someone else saved the translation, after you opened it\..*not kept anywhere/);
  });
});
