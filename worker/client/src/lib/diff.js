// Line diff for version history: Myers' O(ND) algorithm, keeping only the
// diagonals each step reached, so memory grows with the number of changes,
// not with the size of the text. Very different texts fall back to
// "everything removed, everything added" rather than spend seconds.

const MAX_EDITS = 2000;

/** Text as lines; HTML with block tags gets a line per block so a change in one paragraph shows as one line. */
export function splitLines(text) {
  if (!text) return [];
  let t = String(text).replace(/\r\n?/g, '\n');
  if (t.includes('<')) t = t.replace(/>\s*(?=<\/?(?:p|h[1-6]|li|ol|ul|section|article|div|table|tr|td|th|thead|tbody|tfoot|figure|figcaption|blockquote|pre|aside|header|footer|caption|hr|br)\b)/gi, '>\n');
  return t.split('\n');
}

/** Edit script turning `a` into `b`: [{ type: 'same' | 'del' | 'add', line }]. */
export function diffLines(a, b) {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  if (N === 0) return b.map((line) => ({ type: 'add', line }));
  if (M === 0) return a.map((line) => ({ type: 'del', line }));
  const max = Math.min(N + M, MAX_EDITS);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // the diagonals -d-1..d+1 as they were before step d
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x += 1; y += 1; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
    if (found !== -1) break;
  }
  if (found === -1) return [...a.map((line) => ({ type: 'del', line })), ...b.map((line) => ({ type: 'add', line }))];
  const out = [];
  let x = N;
  let y = M;
  for (let d = found; d >= 0; d -= 1) {
    const before = trace[d];
    const at = (k) => before[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x -= 1; y -= 1; out.push({ type: 'same', line: a[x] }); }
    if (d > 0) {
      if (x === prevX) { y -= 1; out.push({ type: 'add', line: b[y] }); } else { x -= 1; out.push({ type: 'del', line: a[x] }); }
    }
  }
  return out.reverse();
}

/**
 * The diff of two texts as shown: changed lines with `context` unchanged lines
 * around them, longer unchanged runs folded into one { type: 'skip', count }.
 */
export function changes(oldText, newText, context = 2) {
  const edits = diffLines(splitLines(oldText), splitLines(newText));
  if (!edits.some((e) => e.type !== 'same')) return [];
  const keep = edits.map(() => false);
  edits.forEach((e, i) => { if (e.type !== 'same') for (let j = Math.max(0, i - context); j <= Math.min(edits.length - 1, i + context); j += 1) keep[j] = true; });
  const out = [];
  let skipped = 0;
  edits.forEach((e, i) => {
    if (keep[i]) { if (skipped) { out.push({ type: 'skip', count: skipped }); skipped = 0; } out.push(e); } else skipped += 1;
  });
  if (skipped) out.push({ type: 'skip', count: skipped });
  return out;
}
