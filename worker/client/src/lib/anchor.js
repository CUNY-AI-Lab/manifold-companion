// Comments on a stretch of text: a W3C-style text-quote selector (the quote and
// a little context) plus a position hint. Re-anchoring after edits finds the
// quote again by its context; when it cannot be found unambiguously enough the
// comment is shown as detached rather than pointing at the wrong words.
// Anchor data comes from other people: it is only ever used as plain text.

export const QUOTE_MAX = 1000;
export const CONTEXT = 32;

export function makeAnchor(text, start, end, pageId) {
  const s = Math.max(0, Math.min(start, end));
  const e = Math.min(text.length, Math.max(start, end), s + QUOTE_MAX);
  const quote = text.slice(s, e);
  if (quote.trim() === '') return null;
  return { quote, prefix: text.slice(Math.max(0, s - CONTEXT), s), suffix: text.slice(e, e + CONTEXT), start: s, end: e, ...(pageId ? { page_id: pageId } : {}) };
}

const commonSuffix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1; return n; };
const commonPrefix = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n += 1; return n; };

/** A shape check: anything else from the server is treated as detached. */
export function isRangeAnchor(a) {
  return !!a && typeof a === 'object' && typeof a.quote === 'string' && a.quote.length > 0 && typeof a.prefix === 'string' && typeof a.suffix === 'string'
    && Number.isInteger(a.start) && Number.isInteger(a.end);
}

/**
 * Where the anchor is in `text` now: { start, end } or null (detached).
 * The quote at its old position with its context is kept. Otherwise each
 * occurrence of the quote is scored by how much of the saved context
 * surrounds it; the best one wins if its context matches at least partly,
 * or if it is the only occurrence. Ties between equally good occurrences
 * are detached: pointing at the wrong one would be worse.
 */
export function locate(anchor, text) {
  if (!isRangeAnchor(anchor) || typeof text !== 'string') return null;
  const { quote, prefix, suffix, start } = anchor;
  const hits = [];
  for (let at = text.indexOf(quote); at !== -1 && hits.length < 500; at = text.indexOf(quote, at + 1)) hits.push(at);
  if (hits.length === 0) return null;
  const score = (at) => commonSuffix(text.slice(Math.max(0, at - prefix.length), at), prefix) + commonPrefix(text.slice(at + quote.length, at + quote.length + suffix.length), suffix);
  const scored = hits.map((at) => ({ at, s: score(at), d: Math.abs(at - start) })).sort((x, y) => y.s - x.s || x.d - y.d);
  const best = scored[0];
  const full = prefix.length + suffix.length;
  if (best.at === start && best.s === full) return { start: best.at, end: best.at + quote.length };
  if (hits.length === 1) return { start: best.at, end: best.at + quote.length };
  if (best.s === 0) return null;
  if (scored[1] && scored[1].s === best.s && scored[1].d === best.d) return null;
  return { start: best.at, end: best.at + quote.length };
}
