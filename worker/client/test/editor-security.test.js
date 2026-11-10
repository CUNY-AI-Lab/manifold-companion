// @vitest-environment jsdom
// The hostile corpus through the visual editor: parse (sanitize -> inert DOM ->
// allowlisted schema), the editor's own rendering into the app page
// (EditorView, with the same node views' inputs), paste, and serialization.
// Nothing active may come out, and the editor's DOM may not carry the
// document's ids, classes, roles, styles or event handlers.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { parseFragment } from 'parse5';
import { XSS_CORPUS } from '../../test/xss-corpus.ts';
import { openDocument, parseHtml, preparePastedHtml, serializeDoc } from '../src/lib/editor/html.js';
import { schema } from '../src/lib/editor/schema.js';
import { drawMath } from '../src/components/RichEditor.jsx';

const ACTIVE = new Set(['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button', 'select', 'link', 'base', 'template', 'noscript', 'frame', 'frameset', 'portal', 'applet', 'audio', 'video', 'source', 'track', 'style', 'meta', 'svg', 'math']);

/** Problems in HTML as a spec-compliant parser builds it. */
function problems(html, { inApp = false } = {}) {
  const out = [];
  const visit = (n) => {
    if (n.tagName) {
      if (ACTIVE.has(n.tagName)) out.push(`<${n.tagName}>`);
      for (const a of n.attrs) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on') || ['srcdoc', 'formaction', 'action', 'srcset', 'style', 'background', 'ping', 'xlink:href'].includes(name)) out.push(`<${n.tagName} ${name}>`);
        if ((name === 'href' || name === 'src') && /^\s*(?:javascript|vbscript|data:text)/i.test(a.value)) out.push(`<${n.tagName} ${name}=${a.value.slice(0, 20)}>`);
        if (inApp && ['id', 'role'].includes(name)) out.push(`<${n.tagName} ${name}> taken from the document`);
        if (inApp && name === 'class' && a.value.split(/\s+/).some((c) => c && !c.startsWith('mc-') && !c.startsWith('ProseMirror'))) out.push(`<${n.tagName} class=${a.value}> taken from the document`);
      }
    }
    (n.childNodes ?? []).forEach(visit);
  };
  visit(parseFragment(html));
  return out;
}

function render(doc) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView(host, { state: EditorState.create({ doc }) });
  const html = host.innerHTML;
  view.destroy();
  host.remove();
  return html;
}

describe('the XSS corpus through the visual editor', () => {
  for (const p of XSS_CORPUS) {
    it(p.name, () => {
      const doc = parseHtml(p.html, { figures: ['a.png'] });
      const back = serializeDoc(doc);
      expect(problems(back), 'serialized').toEqual([]);
      expect(problems(render(doc), { inApp: true }), 'rendered in the app').toEqual([]);
      for (const f of p.forbid ?? []) expect(back.toLowerCase(), `serialized keeps ${f}`).not.toContain(f.toLowerCase());
      // Paste: the same path as a pasted clipboard (sanitized, TeX found, parsed with the schema only).
      const pasted = serializeDoc(parseHtml(preparePastedHtml(p.html)));
      expect(problems(pasted), 'pasted').toEqual([]);
      expect(() => openDocument(p.html)).not.toThrow();
    });
  }

  it('a document cannot plant the app’s ids, classes or roles in the editor', () => {
    const doc = parseHtml('<section id="site-search" class="fixed inset-0 z-50 bg-black" role="dialog" aria-label="x"><p id="main-content" class="sr-only">Text</p></section>');
    const shown = render(doc);
    expect(problems(shown, { inApp: true })).toEqual([]);
    expect(shown).not.toContain('site-search');
    expect(shown).not.toContain('inset-0');
    // ...but they are kept in what is saved.
    expect(serializeDoc(doc)).toContain('id="site-search"');
    expect(serializeDoc(doc)).toContain('class="fixed inset-0 z-50 bg-black"');
  });

  it('TeX that looks like markup stays text in the document and in the stored form', () => {
    const doc = parseHtml('<p>\\(\\text{&lt;img src=x onerror=alert(1)&gt;}\\)</p>');
    let tex = null;
    doc.descendants((n) => { if (n.type === schema.nodes.math) tex = n.attrs.tex; });
    expect(tex).toBe('\\text{<img src=x onerror=alert(1)>}');
    const back = serializeDoc(doc);
    expect(problems(back)).toEqual([]);
    expect(back).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('links: only http, https and mailto survive; images: only this text’s figures', () => {
    const doc = parseHtml('<p><a href="https://ok.example/">a</a><a href="javascript:alert(1)">b</a><a href="mailto:x@example.org">c</a><a href="ftp://x">d</a><img src="mine.png" alt="m"><img src="https://evil.example/t.png" alt="e"><img src="data:image/png;base64,AAAA" alt="d"></p>', { figures: ['mine.png'] });
    const back = serializeDoc(doc);
    expect(back).toContain('href="https://ok.example/"');
    expect(back).toContain('href="mailto:x@example.org"');
    expect(back).not.toMatch(/javascript|ftp:/);
    expect(back).toContain('src="mine.png"');
    expect(back).not.toMatch(/evil\.example|data:image/);
  });

  it('formulas are drawn by KaTeX with trust off: no link, image or HTML from TeX reaches the app page', () => {
    const el = document.createElement('span');
    for (const tex of ['\\href{javascript:alert(1)}{x}', '\\url{javascript:alert(1)}', '\\includegraphics{https://evil.example/x.png}', '\\htmlId{site-search}{x}', '\\htmlClass{fixed inset-0}{x}', '\\htmlStyle{position:fixed}{x}', '\\htmlData{x=1}{y}']) {
      drawMath(el, tex, false);
      expect(el.querySelector('a, img, [id="site-search"], [style*="fixed"], [data-x]'), tex).toBeNull();
      // The TeX may show as (error) text; it never becomes an attribute.
      const attrs = [...el.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((a) => a.value)).join(' ');
      expect(attrs, tex).not.toMatch(/javascript:|evil\.example|inset-0/);
    }
  });
});
