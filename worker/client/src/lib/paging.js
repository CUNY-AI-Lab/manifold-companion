// Paging the text list of a project (the Worker returns at most 50 per request).

export const TEXTS_PER_PAGE = 50;

export const pageCount = (total, size = TEXTS_PER_PAGE) => Math.max(1, Math.ceil(total / size));

/** The 1-based page in `?page=`, clamped to what exists (an unknown count leaves it as asked). */
export function pageFromSearch(search, count = Infinity) {
  const n = Number(new URLSearchParams(search).get('page'));
  return Number.isInteger(n) && n >= 1 ? Math.min(n, count) : 1;
}

/** "Texts 51–100 of 123" */
export function rangeLabel(page, total, size = TEXTS_PER_PAGE) {
  if (total === 0) return 'No texts';
  const first = (page - 1) * size + 1;
  return `Texts ${first}–${Math.min(total, page * size)} of ${total}`;
}

/** Every text of a project, page by page (the export and its table of contents need all of them). */
export async function fetchAllTexts(api, projectId, { size = TEXTS_PER_PAGE, max = 2000 } = {}) {
  const out = [];
  for (let page = 1; out.length < max; page += 1) {
    const r = await api.get(`/api/projects/${projectId}/texts?limit=${size}&page=${page}`);
    out.push(...r.texts);
    if (r.texts.length < size || out.length >= r.total) break;
  }
  return out;
}
