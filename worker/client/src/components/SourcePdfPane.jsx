import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { openPdf } from '../lib/pdf';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** The page a position in the HTML source belongs to: the last <section data-page="N"> opened before it. */
export function pageAtOffset(html, offset) {
  let page = null;
  for (const m of (html ?? '').slice(0, Math.max(0, offset)).matchAll(/<section\b[^>]*\bdata-page="(\d+)"/gi)) page = Number(m[1]);
  return page;
}

/** One step through the zoom levels from the current one (1 is "fit to width"). */
export function nextZoom(zoom, dir) {
  const i = ZOOMS.indexOf(zoom);
  const at = i === -1 ? ZOOMS.indexOf(1) : i;
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + dir))];
}

/**
 * The stored source PDF, drawn one page at a time with pdf.js beside the text,
 * so a person can proofread the conversion against the page it came from.
 * Nothing leaves the browser: the PDF is read from the app's own route.
 * `page` (optional) is the page the text cursor is on; while "Follow the text"
 * is on, the pane shows it.
 */
export default function SourcePdfPane({ textId, fileName, page: followPage }) {
  const [pdf, setPdf] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [follow, setFollow] = useState(true);
  const [width, setWidth] = useState(0);
  const box = useRef(null);
  const canvas = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let doc = null;
    setPdf(null); setError(null);
    (async () => {
      try {
        const blob = await (await api.raw(`/api/texts/${textId}/source-pdf`)).blob();
        doc = await openPdf(blob);
        if (cancelled) { doc.destroy?.(); return; }
        setPdf(doc); setPage(1);
      } catch { if (!cancelled) setError('The source PDF could not be opened here. Download it instead.'); }
    })();
    return () => { cancelled = true; doc?.destroy?.(); };
  }, [textId]);

  // Fit-to-width follows the pane's size.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf]);

  useEffect(() => {
    if (follow && followPage && pdf && followPage >= 1 && followPage <= pdf.numPages) setPage(followPage);
  }, [follow, followPage, pdf]);

  useEffect(() => {
    if (!pdf || !canvas.current || !width) return undefined;
    let task = null;
    let cancelled = false;
    (async () => {
      const p = await pdf.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const scale = ((width - 2) / base.width) * zoom;
      const ratio = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: scale * ratio });
      const c = canvas.current;
      if (!c) return;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      c.style.width = `${Math.floor(viewport.width / ratio)}px`;
      c.style.height = `${Math.floor(viewport.height / ratio)}px`;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      task = p.render({ canvasContext: ctx, viewport });
      await task.promise.catch(() => undefined);
    })();
    return () => { cancelled = true; task?.cancel?.(); };
  }, [pdf, page, zoom, width]);

  const total = pdf?.numPages ?? 0;
  const go = (n) => { if (total) { setPage(Math.min(total, Math.max(1, n))); setFollow(false); } };

  if (error) return <p role="status" className="text-sm">{error}</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm" role="toolbar" aria-label="Source PDF">
        <button type="button" className="btn-quiet" onClick={() => go(page - 1)} disabled={!total || page <= 1}>Previous page</button>
        <label className="inline-flex items-center gap-1">Page
          <input className="field inline-block w-16" type="number" min="1" max={total || 1} value={page} disabled={!total} onChange={(e) => go(Number(e.target.value) || 1)} />
        </label>
        <span>of {total || '…'}</span>
        <button type="button" className="btn-quiet" onClick={() => go(page + 1)} disabled={!total || page >= total}>Next page</button>
        <span className="mx-1 h-5 w-px bg-slate-300 dark:bg-slate-600" aria-hidden="true" />
        <button type="button" className="btn-quiet" aria-label="Zoom out" onClick={() => setZoom((z) => nextZoom(z, -1))} disabled={zoom === ZOOMS[0]}>−</button>
        <span aria-live="polite">Zoom {zoom === 1 ? 'fits the width' : `${Math.round(zoom * 100)}%`}</span>
        <button type="button" className="btn-quiet" aria-label="Zoom in" onClick={() => setZoom((z) => nextZoom(z, 1))} disabled={zoom === ZOOMS[ZOOMS.length - 1]}>+</button>
        <button type="button" className="btn-quiet" onClick={() => setZoom(1)} disabled={zoom === 1}>Fit width</button>
        <label className="inline-flex items-center gap-1"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} aria-describedby={`follow-hint-${textId}`} /> Follow the text</label>
      </div>
      <p id={`follow-hint-${textId}`} className="text-xs text-slate-600 dark:text-slate-300">With “Follow the text” on, the PDF turns to the page your cursor is on in the text. Scroll the page to move around when zoomed in.</p>
      {/* A focusable scroll area, so a zoomed page can be moved around with the keyboard. */}
      <div ref={box} tabIndex={0} role="region" aria-label={`Page ${page} of the source PDF${fileName ? `, ${fileName}` : ''}`} className="min-h-[28rem] max-h-[44rem] overflow-auto rounded-md border border-slate-300 bg-slate-100 dark:border-slate-600 dark:bg-slate-900">
        {pdf ? <canvas ref={canvas} aria-hidden="true" className="block bg-white" /> : <p role="status" className="p-3 text-sm">Opening the source PDF</p>}
      </div>
    </div>
  );
}
