// Uncertain and editorial readings that the transcription prompts mark inline:
// [unclear: …], [illegible], [damaged: …], [deleted: …], [handwritten: …],
// [inserted: …], [annotation: …]. Found here so a reviewer can go straight to
// them; the stored text is never changed.
export const FLAG_KINDS = {
  unclear: { label: 'unclear', doubt: true },
  illegible: { label: 'illegible', doubt: true },
  damaged: { label: 'damaged', doubt: true },
  deleted: { label: 'deleted', doubt: false },
  handwritten: { label: 'handwritten', doubt: false },
  inserted: { label: 'inserted', doubt: false },
  annotation: { label: 'annotation', doubt: false },
};

const FLAG = /\[(unclear|damaged|deleted|handwritten|inserted|annotation):\s*([^\]\n]*)\]|\[(illegible)\]/g;

/** Every flag in a text, in order: { kind, start, end, body }. */
export function findFlags(text) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(FLAG)) {
    const kind = m[1] ?? m[3];
    out.push({ kind, start: m.index, end: m.index + m[0].length, body: (m[2] ?? '').trim() });
  }
  return out;
}

/** Counts by kind and in total; `doubts` counts only the uncertain readings (unclear, illegible, damaged). */
export function flagCounts(text) {
  const byKind = {};
  let doubts = 0;
  const flags = findFlags(text);
  for (const f of flags) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    if (FLAG_KINDS[f.kind].doubt) doubts += 1;
  }
  return { total: flags.length, doubts, byKind };
}

/** "2 unclear, 1 illegible" */
export const describeCounts = ({ byKind }) => Object.keys(FLAG_KINDS).filter((k) => byKind[k]).map((k) => `${byKind[k]} ${FLAG_KINDS[k].label}`).join(', ');

/**
 * The next (dir 1) or previous (dir -1) flag from the caret, across pages.
 * pages: [{ id, text }], at: { pageIndex, offset }. Returns { pageIndex, flag } or null.
 * Next starts after the flag the caret is in or at; previous before it.
 */
export function stepFlag(pages, at, dir) {
  const n = pages.length;
  for (let k = 0; k < n; k += 1) {
    const i = at.pageIndex + dir * k;
    if (i < 0 || i >= n) break;
    const flags = findFlags(pages[i].text);
    if (k === 0) {
      const hit = dir > 0 ? flags.find((f) => f.start > at.offset) : [...flags].reverse().find((f) => f.end <= at.offset && f.start < at.offset);
      if (hit) return { pageIndex: i, flag: hit };
    } else if (flags.length) {
      return { pageIndex: i, flag: dir > 0 ? flags[0] : flags[flags.length - 1] };
    }
  }
  return null;
}

/**
 * Wrap flags in <mark> in SANITIZED preview HTML, in text only (never inside a
 * tag or attribute). The flag text is already escaped by the sanitizer; only the
 * constant <mark> markup is added, and the caller sanitizes the result again.
 */
export function markFlagsInHtml(html) {
  return html.split(/(<[^>]*>)/).map((part) => (part.startsWith('<') ? part : part.replace(FLAG, (m) => `<mark>${m}</mark>`))).join('');
}
