import { PDFDocument } from 'pdf-lib';
import { api } from '../api/client';

/**
 * Extract a single page from a PDF as a standalone PDF, returned as base64.
 */
async function extractPagePdf(pdfBytes, pageIndex) {
  const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const newDoc = await PDFDocument.create();
  const [copiedPage] = await newDoc.copyPages(srcDoc, [pageIndex]);
  newDoc.addPage(copiedPage);
  const bytes = await newDoc.save();

  // Convert Uint8Array to base64 in chunks to avoid call stack overflow
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

/**
 * Extract the text layer from a PDF page using pdfjs-dist (as a hint for the model).
 */
async function extractPageText(pdfDoc, pageNumber) {
  try {
    const page = await pdfDoc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = [];
    let currentLine = [];
    let lastY = null;

    for (const item of textContent.items) {
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (currentLine.length) lines.push(currentLine.join(''));
        currentLine = [];
      }
      currentLine.push(item.str);
      lastY = y;
    }
    if (currentLine.length) lines.push(currentLine.join(''));

    return lines.join('\n');
  } catch {
    return '';
  }
}

export async function convertPdfToHtmlWithBedrock(textId, file, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  const pdfBytes = new Uint8Array(arrayBuffer);

  // Load with pdfjs-dist for text extraction and page count
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;

  const sections = [];
  let unresolvedFormulaCount = 0;

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
    if (onProgress) {
      onProgress({ stage: 'render', pageNumber, totalPages: pdfDoc.numPages });
    }

    // Extract single-page PDF using pdf-lib
    const pdfBase64 = await extractPagePdf(pdfBytes, pageNumber - 1);

    // Extract text hint using pdfjs-dist
    const textHint = await extractPageText(pdfDoc, pageNumber);

    if (onProgress) {
      onProgress({ stage: 'parse', pageNumber, totalPages: pdfDoc.numPages });
    }

    // Server extracts embedded figure images via pdftohtml -xml and saves them
    const parsed = await api.post(`/api/texts/${textId}/pdf-parse-page`, {
      pdfBase64,
      textHint,
      pageNumber,
      totalPages: pdfDoc.numPages,
    });

    sections.push(parsed.html || `<section data-page="${pageNumber}"></section>`);
    unresolvedFormulaCount += Number(parsed.unresolvedFormulaCount || 0);
  }

  const assembledHtml = `<article class="pdf-html-document">\n${sections.join('\n')}\n</article>`;

  if (onProgress) {
    onProgress({ stage: 'cleanup', pageNumber: pdfDoc.numPages, totalPages: pdfDoc.numPages });
  }

  const cleanup = await api.post(`/api/texts/${textId}/pdf-cleanup`, {
    html: assembledHtml,
  });

  return {
    html: cleanup.html || assembledHtml,
    meta: {
      file_name: file.name,
      page_count: pdfDoc.numPages,
      generated_at: new Date().toISOString(),
      pipeline: 'openrouter_gemini_flash',
      unresolved_formula_count: unresolvedFormulaCount,
    },
    formulaStatus: unresolvedFormulaCount > 0 ? 'pending' : 'not_needed',
  };
}
