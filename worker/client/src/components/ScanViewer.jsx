import { useEffect, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import { clampPan, MAX_ZOOM, panAfterZoom, zoomStep } from '../lib/zoom';

const PAN_STEP = 60;

/**
 * A page scan that can be zoomed (buttons, wheel, + − 0) and, once zoomed,
 * moved (drag, arrow keys). The keys work only while the scan has focus, so
 * they never take a key from a text field. Changing the image fits it again.
 */
export function ScanViewer({ src, alt, idBase, onFullScreen, tall = false }) {
  const box = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef(null);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [src]);
  const size = () => ({ w: box.current?.clientWidth ?? 0, h: box.current?.clientHeight ?? 0 });
  const zoomTo = (next) => {
    const { w, h } = size();
    setPan((p) => panAfterZoom(p, zoom, next, w, h));
    setZoom(next);
  };
  const step = (dir) => zoomTo(zoomStep(zoom, dir));
  const fit = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const move = (dx, dy) => { const { w, h } = size(); setPan((p) => clampPan({ x: p.x + dx, y: p.y + dy }, zoom, w, h)); };

  // The wheel zooms the scan instead of scrolling the page: a non-passive listener, so it can prevent the scroll.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (zoomRef.current === 1 && e.deltaY > 0) return; // fitted and zooming out: let the page scroll
      e.preventDefault();
      const next = zoomStep(zoomRef.current, e.deltaY < 0 ? 'in' : 'out');
      const w = el.clientWidth;
      const h = el.clientHeight;
      setPan((p) => panAfterZoom(p, zoomRef.current, next, w, h));
      setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); step('in'); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); step('out'); return; }
    if (e.key === '0') { e.preventDefault(); fit(); return; }
    if (zoom === 1) return; // arrows then belong to whoever holds the viewer (the lightbox turns pages)
    const d = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); move(d[0], d[1]); }
  };
  const onPointerDown = (e) => {
    if (zoom === 1 || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, pan };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const { w, h } = size();
    setPan(clampPan({ x: drag.current.pan.x + e.clientX - drag.current.x, y: drag.current.pan.y + e.clientY - drag.current.y }, zoom, w, h));
  };
  const endDrag = () => { drag.current = null; };
  const percent = Math.round(zoom * 100);
  const hint = `${idBase}-hint`;
  return (
    <div className="flex flex-col gap-1">
      <div role="toolbar" aria-label={`Zoom: ${alt}`} className="flex flex-wrap items-center gap-1 text-sm">
        <button type="button" className="btn-quiet px-2 py-1" onClick={() => step('out')} disabled={zoom === 1} aria-label="Zoom out">−</button>
        <output className="w-14 text-center tabular-nums" aria-live="polite" aria-label="Zoom level">{percent}%</output>
        <button type="button" className="btn-quiet px-2 py-1" onClick={() => step('in')} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in">+</button>
        <button type="button" className="btn-quiet px-2 py-1" onClick={fit} disabled={zoom === 1}>Fit</button>
        {onFullScreen ? <button type="button" className="btn-quiet ml-auto px-2 py-1" onClick={onFullScreen}>Full screen</button> : null}
      </div>
      <div
        ref={box}
        role="group"
        tabIndex={0}
        aria-label={`${alt}, zoom ${percent}%`}
        aria-describedby={hint}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => (zoom === 1 ? zoomTo(2) : fit())}
        className={`relative overflow-hidden rounded-md border border-slate-200 bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cail-blue dark:border-slate-700 dark:bg-slate-900 ${tall ? 'h-[calc(100vh-9rem)]' : 'h-[70vh]'} ${zoom > 1 ? 'cursor-grab touch-none' : ''}`}
      >
        <img src={src} alt={alt} draggable={false} className="h-full w-full select-none object-contain" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center', transition: drag.current ? 'none' : 'transform 80ms ease-out' }} />
      </div>
      <p id={hint} className="text-xs text-slate-600 dark:text-slate-300">Zoom with the buttons, the mouse wheel, a double click, or + and − (0 fits) while the scan has focus. When zoomed, drag the scan or use the arrow keys to move it.</p>
    </div>
  );
}

/** Full-screen page viewer: the same zoom, previous and next page (buttons or ← →), Escape closes. */
export function ScanLightbox({ pages, startIndex, srcOf, onClose }) {
  const ref = useRef(null);
  const [index, setIndex] = useState(startIndex);
  useFocusTrap(ref, true, onClose);
  const page = pages[index];
  const go = (d) => setIndex((i) => Math.min(pages.length - 1, Math.max(0, i + d)));
  // On the document while open: a button that becomes disabled (Next on the last page) drops focus out of the dialog.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = document.activeElement;
    if (ref.current && (!el || el === document.body || el.disabled)) ref.current.focus();
  }, [index]);
  if (!page) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="lightbox-title" tabIndex={-1} className="fixed inset-0 z-[60] flex flex-col gap-2 bg-slate-950/95 p-3 text-white">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="lightbox-title" className="m-0 text-base text-white">Page {page.page_number} of {pages.length}: {page.filename}</h2>
        <span className="flex-1" />
        <button type="button" className="btn-quiet bg-white text-slate-900" onClick={() => go(-1)} disabled={index === 0}>Previous page</button>
        <button type="button" className="btn-quiet bg-white text-slate-900" onClick={() => go(1)} disabled={index === pages.length - 1}>Next page</button>
        <button type="button" className="btn-primary" onClick={onClose}>Close</button>
      </div>
      <div className="min-h-0 flex-1 rounded-md bg-white p-2 text-slate-900 dark:bg-slate-800 dark:text-slate-100">
        <ScanViewer key={page.id} src={srcOf(page)} alt={`Scan of page ${page.page_number}`} idBase="lightbox-scan" tall />
      </div>
      <p className="text-xs text-slate-300">← and → turn the page (when the scan is not zoomed or does not have focus). Escape closes.</p>
    </div>
  );
}
