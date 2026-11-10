// Splitting an image text into runs of pages (the original text stays).

/** Split: new texts from runs of pages, starting at the page numbers given; the original stays. */
export function splitGroups(spec, count) {
  const starts = [...new Set(spec.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 1 && n <= count))].sort((a, b) => a - b);
  const bounds = [1, ...starts, count + 1];
  return bounds.slice(0, -1).map((from, i) => Array.from({ length: bounds[i + 1] - from }, (_, k) => from + k));
}

