import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import useFocusTrap from '../hooks/useFocusTrap';
import { altFromCaption, attachImage, figureName, findPlaceholders } from '../lib/figures';
import { openPdf } from '../lib/pdf';
import { canvasToFigure, cropCanvas, embeddedImages, pageCanvas } from '../lib/pdf-figures';
import { ErrorNote } from './ui';

export const FIGURE_HELP = 'Pictures embedded in the PDF (photos, scans, exported charts) can be taken as they are. Graphs and diagrams drawn with lines and text in the PDF are not pictures inside it: draw a crop around them on the page instead.';

const canvasUrl = (canvas) => new Promise((resolve) => canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), 'image/png'));
const pct = (v) => Math.round(v * 1000) / 10;

/** Drag a rectangle on the page image, or type its edges; the rectangle is in page fractions. */
function CropBox({ src, rect, onChange, label }) {
  const box = useRef(null);
  const start = useRef(null);
  const at = (e) => {
    const r = box.current.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const field = (key, name) => (
    <label className="text-xs"><span className="label">{name} (%)</span>
      <input className="field w-24" type="number" min="0" max="100" step="0.5" value={pct(rect[key])} onChange={(e) => { const v = Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100; onChange({ ...rect, [key]: v }); }} />
    </label>
  );
  return (
    <div>
      <div
        ref={box}
        className="relative inline-block max-w-full cursor-crosshair touch-none select-none border border-slate-300 dark:border-slate-600"
        onPointerDown={(e) => { e.preventDefault(); box.current.setPointerCapture?.(e.pointerId); start.current = at(e); onChange({ ...start.current, w: 0, h: 0 }); }}
        onPointerMove={(e) => { if (!start.current) return; const p = at(e); onChange({ x: Math.min(start.current.x, p.x), y: Math.min(start.current.y, p.y), w: Math.abs(p.x - start.current.x), h: Math.abs(p.y - start.current.y) }); }}
        onPointerUp={() => { start.current = null; }}
      >
        <img src={src} alt={label} className="block max-h-[60vh] max-w-full" draggable={false} />
        {rect.w > 0 && rect.h > 0 ? <div aria-hidden="true" className="pointer-events-none absolute border-2 border-cail-blue bg-cail-blue/10" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} /> : null}
      </div>
      <fieldset className="mt-2 flex flex-wrap gap-2">
        <legend className="sr-only">Crop, in percent of the page</legend>
        {field('x', 'Left edge')}{field('y', 'Top edge')}{field('w', 'Width')}{field('h', 'Height')}
      </fieldset>
    </div>
  );
}

/** Choose the image for one placeholder: an embedded picture of the page, or a crop of the page. */
function FigureDialog({ placeholder, loadPdf, pages, existing, onAttach, onClose }) {
  const ref = useRef(null);
  useFocusTrap(ref, true, onClose);
  const [page, setPage] = useState(placeholder.page && placeholder.page <= pages ? placeholder.page : 1);
  const [state, setState] = useState(null); // { pageUrl, canvas, images: [{ url, canvas, width, height }] }
  const [choice, setChoice] = useState(null); // index of an embedded image, or 'crop'
  const [rect, setRect] = useState({ x: 0.1, y: 0.1, w: 0.8, h: 0.4 });
  const [alt, setAlt] = useState(altFromCaption(placeholder.caption));
  const [busy, setBusy] = useState('Drawing the page');
  const [error, setError] = useState(null);
  const urls = useRef([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => {
    let live = true;
    (async () => {
      setBusy('Drawing the page');
      setError(null);
      try {
        const pdf = await loadPdf();
        const [canvas, found] = await Promise.all([pageCanvas(pdf, page), embeddedImages(pdf, page).catch(() => [])]);
        const pageUrl = await canvasUrl(canvas);
        const images = await Promise.all(found.map(async (f) => ({ ...f, url: await canvasUrl(f.canvas) })));
        urls.current.push(pageUrl, ...images.map((i) => i.url));
        if (live) { setState({ pageUrl, canvas, images }); setChoice(images.length ? 0 : 'crop'); }
      } catch (e) { if (live) setError(e); } finally { if (live) setBusy(null); }
    })();
    return () => { live = false; };
  }, [page, loadPdf]);

  const attach = async () => {
    setBusy('Adding the figure');
    setError(null);
    try {
      const source = choice === 'crop' ? cropCanvas(state.canvas, rect) : state.images[choice].canvas;
      const fig = await canvasToFigure(source);
      const filename = figureName(existing, page, fig.ext);
      await api.upload(`/api/texts/${placeholder.textId}/figures`, fig.blob, { filename, query: { width: String(fig.width), height: String(fig.height) } });
      await onAttach({ filename, alt: alt.trim() || 'Figure', width: fig.width, height: fig.height });
    } catch (e) { setError(e); setBusy(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="figure-title" tabIndex={-1} className="mt-8 w-full max-w-4xl rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">
        <div className="flex items-center justify-between gap-3"><h2 id="figure-title" className="text-lg">Image for: {placeholder.caption || 'a figure'}</h2><button type="button" className="btn-quiet" onClick={onClose}>Close</button></div>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{FIGURE_HELP}</p>
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label><span className="label">PDF page</span><input className="field w-24" type="number" min="1" max={pages} value={page} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= pages) setPage(n); }} /></label>
          <span className="text-slate-600 dark:text-slate-300">of {pages}{placeholder.page ? `; the figure is on page ${placeholder.page} of the conversion` : ''}</span>
        </div>
        {busy ? <p role="status" className="mt-3 text-sm">{busy}</p> : null}
        {state ? (
          <div className="mt-3 space-y-4">
            <fieldset>
              <legend className="label">Pictures embedded on this page</legend>
              {state.images.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">None on this page. Draw a crop below.</p> : (
                <div className="flex flex-wrap gap-2">
                  {state.images.map((img, i) => (
                    <button key={img.url} type="button" aria-pressed={choice === i} onClick={() => setChoice(i)} className={`rounded border-2 p-1 ${choice === i ? 'border-cail-blue' : 'border-transparent'}`}>
                      <img src={img.url} alt={`Embedded picture ${i + 1}, ${img.width} by ${img.height} pixels`} className="h-28 w-auto max-w-[12rem] object-contain" />
                    </button>
                  ))}
                </div>
              )}
            </fieldset>
            <fieldset>
              <legend className="label">Or a crop of the page</legend>
              <label className="mb-2 block text-sm"><input type="radio" name="figure-source" checked={choice === 'crop'} onChange={() => setChoice('crop')} /> Use the crop (drag on the page, or type the edges)</label>
              <CropBox src={state.pageUrl} rect={rect} onChange={(r) => { setRect(r); setChoice('crop'); }} label={`Page ${page} of the PDF`} />
            </fieldset>
            <label className="block text-sm"><span className="label">Alternative text (what the figure shows, for people who cannot see it)</span><input className="field" maxLength={300} value={alt} onChange={(e) => setAlt(e.target.value)} /></label>
            <div className="flex gap-2"><button type="button" className="btn-primary" disabled={!!busy || choice === null || (choice === 'crop' && (rect.w <= 0 || rect.h <= 0))} onClick={attach}>Attach to this figure</button><button type="button" className="btn-quiet" onClick={onClose}>Cancel</button></div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The figures the conversion could not include: one row per
 * <figure class="needs-image"> placeholder in the HTML, each with "Add image".
 * The image is taken from the stored source PDF (or the PDF chosen for the
 * next conversion), uploaded as a figure of this text (quota is reserved like
 * any upload), and the placeholder in the editor gets an <img> naming it; the
 * HTML is saved with the editor's Save.
 */
export default function FigurePanel({ textId, html, setHtml, figures, onUploaded, hasSourcePdf, file, announce }) {
  const placeholders = findPlaceholders(html ?? '');
  const [open, setOpen] = useState(null);
  const [pages, setPages] = useState(null);
  const [error, setError] = useState(null);
  const pdfRef = useRef({ key: null, doc: null });
  const sourceKey = file ? `file:${file.name}:${file.size}` : hasSourcePdf ? 'stored' : null;
  const loadPdf = useRef(null);
  loadPdf.current = async () => {
    if (pdfRef.current.key === sourceKey && pdfRef.current.doc) return pdfRef.current.doc;
    const blob = file ?? (await (await api.raw(`/api/texts/${textId}/source-pdf`)).blob());
    const doc = await openPdf(blob);
    pdfRef.current = { key: sourceKey, doc };
    return doc;
  };
  const stableLoad = useRef(() => loadPdf.current()).current;
  if (placeholders.length === 0) return null;
  const start = async (p) => {
    setError(null);
    try {
      const doc = await stableLoad();
      setPages(doc.numPages);
      setOpen({ ...p, textId });
    } catch (e) { setError(e); }
  };
  return (
    <section aria-labelledby="figures-title" className="mt-4 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <h2 id="figures-title" className="text-base">Figures to add ({placeholders.length})</h2>
      <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">The conversion left a placeholder where each of these figures goes. {FIGURE_HELP}</p>
      {!sourceKey ? <p className="mt-1 text-sm">Store or choose the source PDF first: images are taken from it.</p> : null}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      <ul className="mt-2 space-y-1 text-sm">
        {placeholders.map((p) => (
          <li key={`${p.n}-${p.start}`} className="flex flex-wrap items-center gap-2">
            <span className="flex-1">{p.page ? `Page ${p.page}: ` : ''}{p.caption || 'A figure without a caption'}</span>
            <button type="button" className="btn-quiet" disabled={!sourceKey} onClick={() => start(p)}>Add image<span className="sr-only"> for {p.caption || `figure ${p.n + 1}`}</span></button>
          </li>
        ))}
      </ul>
      {open ? (
        <FigureDialog
          placeholder={open}
          pages={pages}
          loadPdf={stableLoad}
          existing={figures}
          onClose={() => setOpen(null)}
          onAttach={async (fig) => {
            // The editor may have changed while the dialog was open: find the same placeholder again.
            const now = findPlaceholders(html);
            let idx = now.findIndex((p) => p.n === open.n && p.caption === open.caption);
            if (idx < 0) idx = now.findIndex((p) => p.caption === open.caption);
            const next = idx < 0 ? null : attachImage(html, idx, fig);
            await onUploaded();
            if (next === null) { setError({ message: `The figure ${fig.filename} was stored, but its placeholder changed meanwhile; reference it with <img src="${fig.filename}">.` }); setOpen(null); return; }
            setHtml(next);
            setOpen(null);
            announce?.(`Image ${fig.filename} attached. Save the HTML to keep it in the text.`);
          }}
        />
      ) : null}
    </section>
  );
}
