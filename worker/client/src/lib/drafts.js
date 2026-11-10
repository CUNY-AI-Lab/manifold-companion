// Local recovery of unsaved edits. The page origin is shared by every CAIL
// tool, so what is kept is the least that recovers the work:
//   - one draft per text and per person: the text being edited, nothing else
//     (no names, no other pages), plus a hash of the saved text it started
//     from, to say whether the saved text changed since;
//   - the person is a SHA-256 of their opaque subject, so a key names no one;
//   - removed when the edit is saved or discarded, after 7 days, when someone
//     else signs in on this browser (this app cannot see Doorway's sign-out,
//     so a draft of the person who signed out is removed before anything of the
//     next person shows), and from Settings ("Delete drafts kept in this
//     browser") or "Delete my data".
// Pure, with the storage passed in, so it is unit-tested.

export const PREFIX = 'manifold-companion:draft:v1:';
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Larger drafts are not kept (localStorage holds about 5 MB per origin, shared by every CAIL tool). */
export const MAX_DRAFT_CHARS = 1_000_000;

export async function ownerOf(subject, digest = globalThis.crypto?.subtle) {
  const bytes = new Uint8Array(await digest.digest('SHA-256', new TextEncoder().encode(`manifold-companion:${subject}`)));
  return Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** FNV-1a over the UTF-16 code units: enough to tell "the saved text changed" (not a security check). */
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length.toString(36)}.${h.toString(36)}`;
}

export const draftKey = (owner, textId) => `${PREFIX}${owner}:${textId}`;

function read(storage, key) {
  try { return JSON.parse(storage.getItem(key) ?? 'null'); } catch { return null; }
}

/** Keep `content` as the one draft of this text. `target` is { kind: 'page' | 'html' | 'fulltext', pageId? }. Returns whether it was kept. */
export function saveDraft(storage, owner, textId, { target, content, saved }, now = Date.now()) {
  if (!owner || !textId || typeof content !== 'string' || content.length > MAX_DRAFT_CHARS) return false;
  try {
    storage.setItem(draftKey(owner, textId), JSON.stringify({ v: 1, target: { kind: target.kind, ...(target.pageId ? { pageId: target.pageId } : {}) }, content, base: hashText(saved ?? ''), at: now }));
    return true;
  } catch {
    return false; // storage full or unavailable: the leave warning still protects the edit
  }
}

/** The draft of this text, if it is this person's and recent; an expired or malformed one is removed. */
export function loadDraft(storage, owner, textId, now = Date.now()) {
  if (!owner || !textId) return null;
  const key = draftKey(owner, textId);
  const d = read(storage, key);
  if (!d) return null;
  if (d.v !== 1 || typeof d.content !== 'string' || typeof d.at !== 'number' || !d.target || now - d.at > MAX_AGE_MS) { clearDraft(storage, owner, textId); return null; }
  return d;
}

export function clearDraft(storage, owner, textId) {
  try { storage.removeItem(draftKey(owner, textId)); } catch { /* unavailable */ }
}

const ownKeys = (storage) => {
  const keys = [];
  try { for (let i = 0; i < storage.length; i += 1) { const k = storage.key(i); if (k?.startsWith(PREFIX)) keys.push(k); } } catch { /* unavailable */ }
  return keys;
};

/** At sign-in: remove every draft that is not this person's, and this person's expired ones. Returns how many went. */
export function purgeDrafts(storage, owner, now = Date.now()) {
  let removed = 0;
  for (const k of ownKeys(storage)) {
    const d = read(storage, k);
    if (!k.startsWith(`${PREFIX}${owner}:`) || !d || now - (d.at ?? 0) > MAX_AGE_MS) { storage.removeItem(k); removed += 1; }
  }
  return removed;
}

/** Every draft of this app in this browser. */
export function clearAllDrafts(storage) {
  const keys = ownKeys(storage);
  for (const k of keys) storage.removeItem(k);
  return keys.length;
}

export const countDrafts = (storage, owner) => ownKeys(storage).filter((k) => k.startsWith(`${PREFIX}${owner}:`)).length;

/** Does the draft differ from what is saved for its target now? Then it is worth offering. */
export const draftDiffers = (draft, savedNow) => draft.content !== (savedNow ?? '');
/** Did the saved text change after the draft was started (someone else saved, or a model ran)? */
export const savedChangedSince = (draft, savedNow) => draft.base !== hashText(savedNow ?? '');
