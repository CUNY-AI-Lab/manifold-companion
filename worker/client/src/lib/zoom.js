// Zoom and pan of a page scan (components/ScanViewer.jsx). Pure, so it is unit-tested.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5; // 500%, as legacy
const STEP = 1.25;

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

/** One step in or out ("in" | "out"), snapping to 100% near the bottom. */
export function zoomStep(z, dir) {
  const next = clampZoom(dir === 'in' ? z * STEP : z / STEP);
  return next < 1.05 ? 1 : next;
}

/** Keep a zoomed scan covering its box: at zoom z it can move (z-1)/2 of the box each way. */
export function clampPan({ x, y }, z, width, height) {
  const mx = ((z - 1) * width) / 2;
  const my = ((z - 1) * height) / 2;
  const keep = (v, m) => Math.min(m, Math.max(-m, v)) || 0; // || 0: never -0
  return { x: keep(x, mx), y: keep(y, my) };
}

/** The pan after a zoom change, so the same point stays under the centre. */
export function panAfterZoom(pan, from, to, width, height) {
  return clampPan({ x: (pan.x * to) / from, y: (pan.y * to) / from }, to, width, height);
}
