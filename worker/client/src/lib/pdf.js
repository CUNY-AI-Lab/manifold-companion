// pdf.js in the browser: every PDF page becomes an image before any model sees
// it (the Gateway rejects PDF/file parts). The worker script is bundled and
// served same-origin, so the page CSP (script-src 'self') holds.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = await import('pdfjs-dist');
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return lib;
}

export async function openPdf(file) {
  const { getDocument } = await pdfjs();
  // isEvalSupported:false keeps pdf.js from compiling fonts with new Function (CSP has no unsafe-eval).
  return getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
}

const toBlob = (canvas, quality) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode_failed'))), 'image/jpeg', quality));

/**
 * Render one page to a JPEG no larger than maxBytes. Math/table pages are
 * rendered larger so small symbols stay legible; the scale steps down until
 * the image fits the model request cap.
 */
export async function renderPage(pdf, pageNumber, { math = false, maxBytes = 3.5 * 1024 * 1024 } = {}) {
  const page = await pdf.getPage(pageNumber);
  for (const scale of math ? [3, 2.5, 2, 1.5] : [2, 1.5, 1.2]) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    for (const quality of [0.88, 0.75]) {
      const blob = await toBlob(canvas, quality);
      if (blob.size <= maxBytes) return { blob, width: canvas.width, height: canvas.height };
    }
  }
  throw new Error('page_too_large');
}

/** The text layer as a reading-order hint for the model (the image stays authoritative). */
export async function pageTextHint(pdf, pageNumber) {
  try {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let line = [];
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (line.length) lines.push(line.join(''));
        line = [];
      }
      line.push(item.str);
      lastY = y;
    }
    if (line.length) lines.push(line.join(''));
    return lines.join('\n');
  } catch {
    return '';
  }
}
