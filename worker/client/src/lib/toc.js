// The export's table of contents, edited as a flat list with depths (as the
// legacy export panel did) and sent nested. Items: { id, type: 'text'|'section',
// label, depth: 0..MAX_DEPTH, textId? }.

export const MAX_DEPTH = 5;
export const MAX_ITEMS = 500;
export const MAX_LABEL = 200;

/** Texts of the project that are not in the list: removed by the person, so not re-added on the next load. */
export const excludedIds = (items, texts) => texts.filter((t) => !items.some((i) => i.type === 'text' && i.textId === t.id)).map((t) => t.id);

/** Flat list with depths -> nested nodes; a depth jump of more than one nests under the nearest shallower item. */
export function flatToNested(items) {
  const root = [];
  const stack = [{ depth: -1, children: root }];
  for (const item of items) {
    const node = { type: item.type, label: item.label, ...(item.textId != null ? { textId: item.textId } : {}), children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= item.depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ depth: item.depth, children: node.children });
  }
  return root;
}

const clampDepth = (d) => Math.max(0, Math.min(MAX_DEPTH, Number.isInteger(d) ? d : 0));

/**
 * The saved list reconciled with the project's texts now: saved items whose
 * text was deleted are dropped (sections are kept), texts not in the saved
 * list are appended at depth 0, labels of texts follow their current name
 * unless the saved label was edited, and ids are renumbered. Texts the
 * person removed from the export (`excluded`) are not appended again.
 */
export function reconcileToc(saved, texts, excluded = []) {
  const left = new Set(Array.isArray(excluded) ? excluded : []);
  const byId = new Map(texts.map((t) => [t.id, t]));
  const kept = (Array.isArray(saved) ? saved : [])
    .filter((i) => i && (i.type === 'section' ? typeof i.label === 'string' && i.label.trim() !== '' : i.type === 'text' && byId.has(i.textId)))
    .slice(0, MAX_ITEMS);
  const seen = new Set();
  const unique = kept.filter((i) => i.type === 'section' || (!seen.has(i.textId) && seen.add(i.textId)));
  const items = [...unique.map((i) => ({ type: i.type, label: String(i.label ?? byId.get(i.textId)?.name ?? '').slice(0, MAX_LABEL), depth: clampDepth(i.depth), ...(i.type === 'text' ? { textId: i.textId } : {}) })),
    ...texts.filter((t) => !seen.has(t.id) && !left.has(t.id)).map((t) => ({ type: 'text', label: t.name, depth: 0, textId: t.id }))];
  return items.map((i, n) => ({ ...i, id: n + 1 }));
}

export const nextId = (items) => items.reduce((m, i) => Math.max(m, i.id), 0) + 1;

export function move(items, index, delta) {
  const to = index + delta;
  if (to < 0 || to >= items.length) return items;
  const out = [...items];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

export function indent(items, index, delta) {
  return items.map((item, i) => (i === index ? { ...item, depth: clampDepth(item.depth + delta) } : item));
}

export const remove = (items, index) => items.filter((_, i) => i !== index);

export function addSection(items, label) {
  const clean = label.trim().slice(0, MAX_LABEL);
  if (!clean || items.length >= MAX_ITEMS) return items;
  return [...items, { id: nextId(items), type: 'section', label: clean, depth: 0 }];
}

export function addText(items, text) {
  if (items.some((i) => i.type === 'text' && i.textId === text.id) || items.length >= MAX_ITEMS) return items;
  return [...items, { id: nextId(items), type: 'text', label: text.name, depth: 0, textId: text.id }];
}

export const relabel = (items, index, label) => items.map((item, i) => (i === index ? { ...item, label: label.slice(0, MAX_LABEL) } : item));
