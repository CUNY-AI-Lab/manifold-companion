// Editing commands and plugins for the visual editor (ProseMirror).
import { baseKeymap, chainCommands, lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { gapCursor } from 'prosemirror-gapcursor';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { NodeSelection, Plugin } from 'prosemirror-state';
import { schema, SAFE_LINK } from './schema.js';

const { nodes: N, marks: M } = schema;

export const markActive = (state, type) => {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
};

/** The block type of the selection's start: "paragraph", "h2" ... */
export function blockKind(state) {
  const parent = state.selection.$from.parent;
  if (parent.type === N.heading) return `h${parent.attrs.level}`;
  if (parent.type === N.code_block) return 'code';
  return 'paragraph';
}

export function setBlock(kind) {
  if (kind === 'paragraph') return setBlockType(N.paragraph);
  if (kind === 'code') return setBlockType(N.code_block);
  return setBlockType(N.heading, { level: Number(kind.slice(1)) });
}

export const cmd = {
  bold: toggleMark(M.strong),
  italic: toggleMark(M.em),
  code: toggleMark(M.code),
  sup: toggleMark(M.sup),
  sub: toggleMark(M.sub),
  bulletList: wrapInList(N.bullet_list),
  orderedList: wrapInList(N.ordered_list),
  indent: sinkListItem(N.list_item),
  outdent: chainCommands(liftListItem(N.list_item), lift),
  quote: wrapIn(N.blockquote),
  undo,
  redo,
};

/** Add or change a link on the selection: only http, https and mailto addresses. Returns false for anything else. */
export function setLink(href) {
  const value = href.trim();
  return (state, dispatch) => {
    if (state.selection.empty) return false;
    if (value === '') { if (dispatch) dispatch(state.tr.removeMark(state.selection.from, state.selection.to, M.link)); return true; }
    if (!SAFE_LINK.test(value)) return false;
    if (dispatch) dispatch(state.tr.removeMark(state.selection.from, state.selection.to, M.link).addMark(state.selection.from, state.selection.to, M.link.create({ href: value })));
    return true;
  };
}

export const linkOf = (state) => {
  const { $from } = state.selection;
  return M.link.isInSet($from.marks())?.attrs.href ?? (state.selection.empty ? null : '');
};

/** Insert a formula at the selection, or replace the formula selected. */
export function putMath(tex, display, pos = null) {
  return (state, dispatch) => {
    const node = N.math.create({ tex, display });
    if (dispatch) {
      const tr = pos === null ? state.tr.replaceSelectionWith(node) : state.tr.setNodeMarkup(pos, null, { tex, display });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export const selectedMath = (state) => (state.selection instanceof NodeSelection && state.selection.node.type === N.math ? { pos: state.selection.from, node: state.selection.node } : null);

/**
 * Two bare paragraphs side by side would be written as one run of text and
 * merge when read back; a split of a bare paragraph makes such a pair. The
 * later one becomes a <p>.
 */
const keepBareApart = new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some((t) => t.docChanged)) return null;
    let tr = null;
    const scan = (parent, base) => {
      let prevBare = false;
      parent.forEach((child, offset) => {
        const bare = child.type === N.paragraph && child.attrs.bare;
        if (bare && prevBare) {
          tr = tr ?? state.tr;
          tr.setNodeMarkup(base + offset, null, { ...child.attrs, bare: false });
          prevBare = false;
        } else prevBare = bare;
      });
    };
    scan(state.doc, 0);
    state.doc.descendants((node, pos) => {
      if (node.isTextblock || node.isLeaf) return false;
      scan(node, pos + 1);
      return true;
    });
    return tr;
  },
});

export function plugins({ onEditMath, onLink }) {
  return [
    history(),
    keymap({
      'Mod-b': cmd.bold, 'Mod-i': cmd.italic, 'Mod-`': cmd.code,
      'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
      'Mod-[': cmd.outdent, 'Mod-]': cmd.indent,
      'Mod-k': () => { onLink(); return true; },
      'Mod-Shift-m': (state) => { onEditMath(selectedMath(state) ?? { pos: null, node: null }); return true; },
      Enter: chainCommands((state) => { const m = selectedMath(state); if (m) { onEditMath(m); return true; } return false; }, splitListItem(N.list_item)),
    }),
    keymap(baseKeymap),
    gapCursor(),
    keepBareApart,
  ];
}
