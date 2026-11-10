import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { MAX_AGE_MS, MAX_DRAFT_CHARS, MAX_TOTAL_DRAFT_CHARS, PREFIX, clearAllDrafts, clearDraft, countDrafts, draftDiffers, draftKey, hashText, loadDraft, ownerOf, purgeDrafts, saveDraft, savedChangedSince } from '../src/lib/drafts.js';

function memoryStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

describe('local drafts', () => {
  it('the person in a key is a hash, never the subject', async () => {
    const owner = await ownerOf('cail-0123456789abcdef0123456789abcdef', webcrypto.subtle);
    expect(owner).toMatch(/^[0-9a-f]{32}$/);
    expect(owner).not.toContain('0123456789abcdef');
    expect(await ownerOf('cail-0123456789abcdef0123456789abcdef', webcrypto.subtle)).toBe(owner);
    expect(await ownerOf('cail-ffffffffffffffffffffffffffffffff', webcrypto.subtle)).not.toBe(owner);
  });

  it('keeps one draft per text and person: only the edited text and a hash of what it started from', () => {
    const s = memoryStorage();
    expect(saveDraft(s, 'me', 't1', { target: { kind: 'page', pageId: 'p2' }, content: 'my edit', saved: 'saved text' }, 1000)).toBe(true);
    saveDraft(s, 'me', 't1', { target: { kind: 'page', pageId: 'p3' }, content: 'later edit', saved: 'other' }, 2000);
    const stored = s.dump();
    expect(Object.keys(stored)).toEqual([`${PREFIX}me:t1`]);
    const value = JSON.parse(stored[draftKey('me', 't1')]);
    expect(value).toEqual({ v: 1, target: { kind: 'page', pageId: 'p3' }, content: 'later edit', base: hashText('other'), at: 2000 });
    expect(JSON.stringify(value)).not.toContain('other'); // the saved text itself is not stored
    expect(loadDraft(s, 'me', 't1', 3000)).toMatchObject({ content: 'later edit' });
    expect(loadDraft(s, 'someone-else', 't1', 3000)).toBeNull();
    expect(loadDraft(s, 'me', 't2', 3000)).toBeNull();
  });

  it('is cleared on save or discard, expires after 7 days, and is not kept when too large', () => {
    const s = memoryStorage();
    saveDraft(s, 'me', 't1', { target: { kind: 'html' }, content: 'x', saved: '' }, 0);
    clearDraft(s, 'me', 't1');
    expect(loadDraft(s, 'me', 't1', 1)).toBeNull();
    saveDraft(s, 'me', 't1', { target: { kind: 'html' }, content: 'x', saved: '' }, 0);
    expect(loadDraft(s, 'me', 't1', MAX_AGE_MS + 1)).toBeNull();
    expect(s.length).toBe(0); // the expired one was removed
    expect(saveDraft(s, 'me', 't1', { target: { kind: 'html' }, content: 'x'.repeat(MAX_DRAFT_CHARS + 1), saved: '' })).toBe(false);
    s.setItem(draftKey('me', 'bad'), '{not json');
    expect(loadDraft(s, 'me', 'bad')).toBeNull();
  });

  it('at sign-in, drafts of anyone else (and expired ones) are removed; other tools\' keys are left alone', () => {
    const s = memoryStorage();
    saveDraft(s, 'previous-person', 't1', { target: { kind: 'html' }, content: 'theirs', saved: '' }, 100);
    saveDraft(s, 'me', 't2', { target: { kind: 'html' }, content: 'mine', saved: '' }, 100);
    saveDraft(s, 'me', 't3', { target: { kind: 'html' }, content: 'old', saved: '' }, 0);
    s.setItem('another-tool:setting', 'kept');
    expect(purgeDrafts(s, 'me', MAX_AGE_MS + 50)).toBe(2);
    expect(Object.keys(s.dump()).sort()).toEqual(['another-tool:setting', draftKey('me', 't2')]);
    expect(countDrafts(s, 'me')).toBe(1);
    expect(clearAllDrafts(s)).toBe(1);
    expect(s.dump()).toEqual({ 'another-tool:setting': 'kept' });
  });

  it('says whether a draft is worth offering and whether the saved text changed meanwhile', () => {
    const s = memoryStorage();
    saveDraft(s, 'me', 't', { target: { kind: 'page', pageId: 'p' }, content: 'edit', saved: 'v1' });
    const d = loadDraft(s, 'me', 't');
    expect(draftDiffers(d, 'v1')).toBe(true);
    expect(draftDiffers(d, 'edit')).toBe(false);
    expect(savedChangedSince(d, 'v1')).toBe(false);
    expect(savedChangedSince(d, 'v2 from a model run')).toBe(true);
    expect(hashText('a')).not.toBe(hashText('b'));
  });

  it('a storage that throws (private mode, full) never breaks editing', () => {
    const broken = { get length() { throw new Error('denied'); }, key() { throw new Error('denied'); }, getItem() { throw new Error('denied'); }, setItem() { throw new Error('QuotaExceededError'); }, removeItem() { throw new Error('denied'); } };
    expect(saveDraft(broken, 'me', 't', { target: { kind: 'html' }, content: 'x', saved: '' })).toBe(false);
    expect(loadDraft(broken, 'me', 't')).toBeNull();
    expect(() => clearDraft(broken, 'me', 't')).not.toThrow();
    expect(purgeDrafts(broken, 'me')).toBe(0);
  });

  it('all drafts together stay within a budget: the storage of the origin is shared by every CAIL tool', () => {
    const s = memoryStorage();
    const big = 'x'.repeat(Math.floor(MAX_DRAFT_CHARS * 0.9));
    expect(MAX_TOTAL_DRAFT_CHARS).toBeLessThanOrEqual(1_500_000);
    expect(saveDraft(s, 'me', 't1', { target: { kind: 'html' }, content: big, saved: '' }, 1000)).toBe(true);
    expect(saveDraft(s, 'me', 't2', { target: { kind: 'html' }, content: big, saved: '' }, 2000)).toBe(true);
    // The older draft made room: what this app keeps never passes the budget.
    const total = Object.entries(s.dump()).filter(([k]) => k.startsWith(PREFIX)).reduce((n, [k, v]) => n + k.length + v.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_DRAFT_CHARS);
    expect(loadDraft(s, 'me', 't2', 3000)).not.toBeNull();
    expect(loadDraft(s, 'me', 't1', 3000)).toBeNull();
    // Another tool's data on the origin is never touched.
    s.setItem('other-tool:state', 'keep');
    saveDraft(s, 'me', 't3', { target: { kind: 'html' }, content: big, saved: '' }, 4000);
    expect(s.getItem('other-tool:state')).toBe('keep');
  });
});
