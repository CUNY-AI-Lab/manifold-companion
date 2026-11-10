// Previews of stored, user-authored HTML and Markdown. They are rendered ONLY
// inside a sandboxed srcdoc iframe without allow-same-origin or allow-scripts
// (components/SandboxedPreview.jsx); the Worker also sanitizes on write. TeX is
// turned into MathML here (temml, no fonts or scripts needed), the same
// conversion the export uses.
import { marked } from 'marked';
import temml from 'temml';

export function texToMathml(html) {
  const render = (tex, displayMode) => {
    try {
      return temml.renderToString(tex.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim(), { displayMode });
    } catch {
      return null;
    }
  };
  return html
    .replace(/\\\[([\s\S]{1,2000}?)\\\]/g, (m, t) => render(t, true) ?? m)
    .replace(/\$\$([\s\S]{1,2000}?)\$\$/g, (m, t) => render(t, true) ?? m)
    .replace(/\\\(([\s\S]{1,1000}?)\\\)/g, (m, t) => render(t, false) ?? m);
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: Charter, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: 17px; line-height: 1.6; max-width: 46rem; margin: 1.5rem auto; padding: 0 1.25rem; color: #1e293b; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e2e8f0; background: #0f172a; } a { color: #93c5fd; } }
  h1, h2, h3, h4 { line-height: 1.25; } img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: 1rem 0; } td, th { border: 1px solid #cbd5e1; padding: .3rem .5rem; }
  table.equation-table td { border: 0; }
  section[data-page] { border-top: 1px dashed #cbd5e1; padding-top: .5rem; margin-top: 1rem; }
  section[data-page]::before { content: "Page " attr(data-page); font: 12px system-ui, sans-serif; color: #64748b; }
  aside, blockquote { border-left: 3px solid #94a3b8; margin-left: 0; padding-left: 1rem; }
  math[display="block"] { margin: .75rem 0; }
`;

/** A complete srcdoc document. `images` maps a figure file name to a data: URI. */
export function previewDocument({ html, markdown, images = {} }) {
  // TeX first: Markdown's backslash escapes would otherwise turn \( into a bare parenthesis.
  let body = markdown !== undefined ? marked.parse(texToMathml(markdown ?? ''), { async: false }) : texToMathml(html ?? '');
  body = body.replace(/ src="([^"/]+)"/g, (m, name) => (images[name] ? ` src="${images[name]}"` : m));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${STYLE}</style></head><body>${body}</body></html>`;
}
