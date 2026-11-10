import { useEffect, useRef, useState } from 'react';

export const carriesFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * Files dropped anywhere on the page. While `enabled`, a drag that carries
 * files shows `dragging` (for an overlay) and a drop hands the files to
 * `onDrop`. Always, a file dropped where nothing takes it is stopped: the
 * browser would otherwise open the file in place of the app and lose unsaved
 * work. The drop is a shortcut only; every upload also has a button.
 */
export default function useFileDrop({ enabled, onDrop }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onDrop);
  handler.current = onDrop;
  useEffect(() => {
    const enter = (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      if (enabled) setDragging(true);
    };
    const over = (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
    };
    const leave = (e) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (enabled && files.length) handler.current(files);
    };
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragover', over);
    document.addEventListener('dragleave', leave);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragover', over);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('drop', drop);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);
  return dragging;
}

/**
 * App-wide: a file dropped on a page that takes no files must not replace the
 * app (the browser's default opens the file, and unsaved work is lost). Only
 * stops the default; never sets a drop effect, so a page that takes files
 * decides that.
 */
export function useNoFileNavigation() {
  useEffect(() => {
    const stop = (e) => { if (carriesFiles(e)) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);
}

/** Split dropped files into those `accepts` takes and the names of the rest. */
export function sortDropped(files, accepts) {
  const taken = [];
  const refused = [];
  for (const f of files) (accepts(f) ? taken : refused).push(f);
  return { taken, refused: refused.map((f) => f.name) };
}

/** The overlay shown while files are dragged over a page that takes them. */
export function DropOverlay({ show, label }) {
  if (!show) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-cail-blue/10 p-6">
      <div className="rounded-lg border-2 border-dashed border-cail-blue bg-white px-8 py-6 text-center text-base font-medium text-cail-navy shadow-lg dark:bg-slate-800 dark:text-slate-100">{label}</div>
    </div>
  );
}
