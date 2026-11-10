// Figures from a PDF, in the browser (there is no server-side PDF tooling).
// Two ways, because PDFs hold figures two ways:
//   - an embedded raster image (a photo, a scan, an exported chart): taken
//     from pdf.js's operator list at its own resolution;
//   - a vector drawing (lines, curves and text: most graphs and diagrams in a
//     textbook): there is no image to take, so the person draws a crop on the
//     rasterised page.
import { pdfjs } from './pdf';
import { cropPixels, toRgba } from './figures';

const toBlob = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode_failed'))), type, quality));

/** PNG for line art and small images; JPEG when a PNG would pass `maxBytes` (the figure route takes 10 MB). */
export async function canvasToFigure(canvas, maxBytes = 8 * 1024 * 1024) {
  const png = await toBlob(canvas, 'image/png');
  if (png.size <= maxBytes) return { blob: png, ext: 'png', width: canvas.width, height: canvas.height };
  for (const q of [0.92, 0.85, 0.75]) {
    const jpg = await toBlob(canvas, 'image/jpeg', q);
    if (jpg.size <= maxBytes) return { blob: jpg, ext: 'jpg', width: canvas.width, height: canvas.height };
  }
  throw new Error('figure_too_large');
}

function objectOf(page, id) {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    try {
      store.get(id, (obj) => { clearTimeout(timer); resolve(obj); });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function imageCanvas(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else ctx.putImageData(new ImageData(toRgba(img), img.width, img.height), 0, 0);
  return canvas;
}

/** The raster images embedded on one page, largest first, skipping tiny ones (rules, bullets, decorations). */
export async function embeddedImages(pdf, pageNumber, { minSide = 32, max = 24 } = {}) {
  const { OPS } = await pdfjs();
  const page = await pdf.getPage(pageNumber);
  const ops = await page.getOperatorList();
  const seen = new Set();
  const out = [];
  for (let i = 0; i < ops.fnArray.length && out.length < max; i += 1) {
    const fn = ops.fnArray[i];
    let img = null;
    if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const id = ops.argsArray[i][0];
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      img = await objectOf(page, id);
    } else if (fn === OPS.paintInlineImageXObject) {
      img = ops.argsArray[i][0];
    }
    if (!img || !img.width || !img.height || Math.min(img.width, img.height) < minSide) continue;
    try { out.push({ canvas: imageCanvas(img), width: img.width, height: img.height }); } catch { /* an image kind this cannot draw: the crop still works */ }
  }
  return out.sort((a, b) => b.width * b.height - a.width * a.height);
}

/** The page drawn for cropping, at a scale that keeps small labels legible. */
export async function pageCanvas(pdf, pageNumber, scale = 2.5) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** A crop (page fractions) of a page canvas, as a new canvas. */
export function cropCanvas(source, rect) {
  const r = cropPixels(rect, source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext('2d').drawImage(source, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return canvas;
}
