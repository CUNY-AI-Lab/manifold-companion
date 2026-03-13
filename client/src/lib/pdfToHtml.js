function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function detectFormula(text) {
  const value = normalizeWhitespace(text);
  if (!value) return false;
  if (value.length > 140 || /[.?!]$/.test(value)) return false;
  if (/^\d{1,4}$/.test(value)) return false;
  if (/^(example|section|chapter)\b/i.test(value)) return false;
  if (/^\d+\s+(chapter|section)\b/i.test(value)) return false;

  const displayMathChars = /[∑∫√≤≥≈≠∞∂πλμΔΣΠ∈∀∃→↔]/;
  const equationPattern = /\b[A-Za-z]\s*=\s*[A-Za-z0-9(]/;
  const functionPattern = /\b[A-Za-z]+\s*\(\s*[A-Za-z0-9,+\-*/\s]+\s*\)/;
  const bracketCount = countMatches(value, /[()[\]{}]/g);
  const operatorCount = countMatches(value, /[=+\-*/^]/g);
  const digitCount = countMatches(value, /\d/g);
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  const alphaCount = countMatches(value, /[A-Za-z]/g);
  const symbolDensity = (operatorCount + bracketCount + digitCount) / Math.max(value.length, 1);

  if (displayMathChars.test(value)) return true;
  if (equationPattern.test(value) && wordCount <= 8) return true;
  if (functionPattern.test(value) && (operatorCount > 0 || digitCount > 0) && wordCount <= 6) return true;
  if (operatorCount >= 2 && bracketCount >= 2 && wordCount <= 10) return true;
  if (symbolDensity > 0.18 && alphaCount < value.length * 0.65 && wordCount <= 18) return true;

  return false;
}

function isBoldFont(fontName = '') {
  return /bold|black|heavy|demi|semibold/i.test(fontName);
}

function isItalicFont(fontName = '') {
  return /italic|oblique/i.test(fontName);
}

function mergeItemsIntoLine(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = '';
  let previous = null;

  for (const item of sorted) {
    const value = item.str || '';
    if (!value.trim()) {
      previous = item;
      continue;
    }

    const gap = previous ? item.x - (previous.x + previous.width) : 0;
    const needsSpace = previous
      && gap > Math.max(2, previous.fontSize * 0.18)
      && !/[(/-]$/.test(text)
      && !/^[,.;:)\]%]/.test(value);

    text += `${needsSpace ? ' ' : ''}${value}`;
    previous = item;
  }

  return normalizeWhitespace(text);
}

function renderStyledLine(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const segments = [];
  let previous = null;

  for (const item of sorted) {
    const rawValue = item.str || '';
    if (!rawValue.trim()) {
      previous = item;
      continue;
    }

    const gap = previous ? item.x - (previous.x + previous.width) : 0;
    const needsSpace = previous
      && gap > Math.max(2, previous.fontSize * 0.18)
      && !/[(/-]$/.test(segments.at(-1)?.text || '')
      && !/^[,.;:)\]%]/.test(rawValue);

    const text = `${needsSpace ? ' ' : ''}${rawValue}`;
    const bold = isBoldFont(item.fontName);
    const italic = isItalicFont(item.fontName);
    const previousSegment = segments.at(-1);

    if (previousSegment && previousSegment.bold === bold && previousSegment.italic === italic) {
      previousSegment.text += text;
    } else {
      segments.push({ text, bold, italic });
    }

    previous = item;
  }

  return segments
    .map((segment) => {
      let content = escapeHtml(segment.text);
      if (segment.bold) content = `<strong>${content}</strong>`;
      if (segment.italic) content = `<em>${content}</em>`;
      return content;
    })
    .join('');
}

function describeLineStyle(line) {
  const visibleItems = line.items.filter((item) => item.str && item.str.trim());
  const totalChars = visibleItems.reduce((sum, item) => sum + item.str.trim().length, 0) || 1;
  const boldChars = visibleItems.reduce((sum, item) => sum + (isBoldFont(item.fontName) ? item.str.trim().length : 0), 0);
  const italicChars = visibleItems.reduce((sum, item) => sum + (isItalicFont(item.fontName) ? item.str.trim().length : 0), 0);

  return {
    boldRatio: boldChars / totalChars,
    italicRatio: italicChars / totalChars,
    html: renderStyledLine(visibleItems),
  };
}

function groupItemsByLine(items) {
  const lines = [];

  for (const item of items) {
    const y = item.transform?.[5] || 0;
    const x = item.transform?.[4] || 0;
    const fontSize = Math.abs(item.transform?.[0] || item.height || 12);
    const width = item.width || Math.max(fontSize * 0.5, String(item.str || '').length * fontSize * 0.45);
    const existing = lines.find((line) => Math.abs(line.y - y) <= Math.max(3, fontSize * 0.25));

    if (existing) {
      existing.items.push({ ...item, x, y, fontSize, width });
      existing.avgFontSize = (existing.avgFontSize * (existing.items.length - 1) + fontSize) / existing.items.length;
      existing.minX = Math.min(existing.minX, x);
      existing.maxX = Math.max(existing.maxX, x + width);
    } else {
      lines.push({
        y,
        items: [{ ...item, x, y, fontSize, width }],
        avgFontSize: fontSize,
        minX: x,
        maxX: x + width,
      });
    }
  }

  return lines
    .map((line) => ({
      ...line,
      text: mergeItemsIntoLine(line.items),
      ...describeLineStyle(line),
    }))
    .filter((line) => line.text)
    .sort((a, b) => b.y - a.y);
}

function buildTocEntry(text) {
  const match = text.match(/^(.*?)(?:\.{3,}|\s{2,})(\d+)\s*$/)
    || text.match(/^((?:Section|Chapter|Appendix|Part)\b.+?)\s+(\d+)\s*$/i);
  if (!match) return null;

  return (
    `<div class="toc-entry">` +
    `<span class="toc-entry__title">${escapeHtml(match[1].trim())}</span>` +
    `<span class="toc-entry__page">${escapeHtml(match[2])}</span>` +
    `</div>`
  );
}

function buildTocEntries(text) {
  const normalized = normalizeWhitespace(text);
  const repeatedEntries = [...normalized.matchAll(/((?:Section|Chapter|Appendix|Part)\s+.*?)(?:\.{3,}|\s{2,})(\d+)/gi)];

  if (repeatedEntries.length >= 2) {
    return repeatedEntries
      .map((match) => buildTocEntry(`${match[1]} ${match[2]}`))
      .filter(Boolean)
      .join('');
  }

  return buildTocEntry(text);
}

function isLikelyPageArtifact(line, pageStats) {
  const text = line.text;
  const nearTop = line.y >= pageStats.topThreshold;
  const nearBottom = line.y <= pageStats.bottomThreshold;

  if ((nearTop || nearBottom) && /^\d{1,4}$/.test(text)) return true;
  if ((nearTop || nearBottom) && /^\d+\s+(chapter|section)\b/i.test(text)) return true;
  if ((nearTop || nearBottom) && /^Section\s+\d/i.test(text) && /\d{1,4}\s*$/.test(text)) return true;
  if (nearBottom && /^This chapter is part of /i.test(text)) return true;

  return false;
}

function looksLikeTitle(text) {
  return /^[A-Z0-9“"'(][A-Za-z0-9“”"'():;,\- ]+$/.test(text)
    && !/[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}/.test(text);
}

function classifyLine(line, pageStats, formulaIdRef, formulas, pageNumber) {
  const text = line.text;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const endsLikeHeading = !/\.$/.test(text);

  if (isLikelyPageArtifact(line, pageStats)) {
    return '';
  }

  if (detectFormula(text)) {
    const id = `formula-${formulaIdRef.current++}`;
    formulas.push({ id, text, context: '' });
    return `<div class="formula-block" data-formula-id="${id}" data-formula-source="${escapeHtml(text)}">${escapeHtml(text)}</div>`;
  }

  const tocEntry = buildTocEntries(text);
  if (tocEntry) {
    return tocEntry;
  }

  const shortLine = text.length <= 90;
  const largeType = line.avgFontSize >= pageStats.medianFontSize * 1.18;
  const veryLargeType = line.avgFontSize >= pageStats.maxFontSize * 0.88;
  const stronglyEmphasized = line.boldRatio >= 0.55 || line.italicRatio >= 0.7;
  const titleLike = looksLikeTitle(text);
  const veryShort = wordCount <= 6;
  const sectionLike = /^(chapter|section|example|try it now|function notation|one-to-one function|what is a function)\b/i.test(text);

  if (/^Section\s+\d/i.test(text) && wordCount <= 12) {
    return `<h2>${line.html}</h2>`;
  }

  if (pageNumber === 1 && shortLine && veryShort && endsLikeHeading && veryLargeType && (stronglyEmphasized || sectionLike)) {
    return `<h1>${line.html}</h1>`;
  }

  if (shortLine && wordCount <= 8 && endsLikeHeading && largeType && (stronglyEmphasized || sectionLike)) {
    return `<h2>${line.html}</h2>`;
  }

  if (
    shortLine
    && wordCount <= 10
    && endsLikeHeading
    && (line.boldRatio >= 0.45 || /^Example\s+\d+/i.test(text) || sectionLike)
    && titleLike
  ) {
    return `<h3>${line.html}</h3>`;
  }

  return null;
}

function buildPageHtml(pageNumber, lines, formulaIdRef, formulas) {
  const fontSizes = lines.map((line) => line.avgFontSize).sort((a, b) => a - b);
  const ys = lines.map((line) => line.y).sort((a, b) => a - b);
  const minY = ys[0] ?? 0;
  const maxY = ys[ys.length - 1] ?? 0;
  const pageHeight = Math.max(1, maxY - minY);
  const pageStats = {
    medianFontSize: fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 12,
    maxFontSize: fontSizes.length ? fontSizes[fontSizes.length - 1] : 12,
    topThreshold: maxY - pageHeight * 0.08,
    bottomThreshold: minY + pageHeight * 0.05,
  };
  const chunks = [`<section data-page="${pageNumber}">`];
  let paragraph = [];
  let previousLine = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const html = paragraph.join(' ');
    const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    if (/^Section\s+\d/i.test(plainText) && plainText.split(/\s+/).length <= 12) {
      chunks.push(`<h2>${html}</h2>`);
    } else if (
      /^(Example\s+\d+|Try it Now|One-to-One Function|Function Notation|What is a Function)\b/i.test(plainText)
      && plainText.split(/\s+/).length <= 10
    ) {
      chunks.push(`<h3>${html}</h3>`);
    } else {
      chunks.push(`<p>${html}</p>`);
    }
    paragraph = [];
  };

  for (const line of lines) {
    const special = classifyLine(line, pageStats, formulaIdRef, formulas, pageNumber);
    const verticalGap = previousLine ? Math.abs(previousLine.y - line.y) : 0;
    const indentShift = previousLine ? Math.abs(line.minX - previousLine.minX) : 0;
    const likelyBreak = previousLine
      && (verticalGap > Math.max(previousLine.avgFontSize * 1.7, 16) || indentShift > previousLine.avgFontSize * 1.4);

    if (special === '') {
      flushParagraph();
      previousLine = line;
      continue;
    }

    if (special) {
      flushParagraph();
      chunks.push(special);
      previousLine = line;
      continue;
    }

    if (likelyBreak) {
      flushParagraph();
    }

    paragraph.push(line.html);
    previousLine = line;
  }

  flushParagraph();
  chunks.push('</section>');
  return chunks.join('\n');
}

export async function convertPdfToHtml(file) {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const formulas = [];
  const formulaIdRef = { current: 1 };
  const sections = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const lines = groupItemsByLine(textContent.items || []);
    sections.push(buildPageHtml(pageNumber, lines, formulaIdRef, formulas));
  }

  return {
    html: `<article class="pdf-html-document">\n${sections.join('\n')}\n</article>`,
    formulas,
    meta: {
      file_name: file.name,
      page_count: pdf.numPages,
      formula_count: formulas.length,
      generated_at: new Date().toISOString(),
    },
  };
}

export function extractFormulaCandidatesFromHtml(html, context = '') {
  const matches = [...html.matchAll(/<div class="formula-block" data-formula-id="([^"]+)"(?: data-formula-source="([^"]*)")?>([\s\S]*?)<\/div>/g)];
  return matches.map((match) => ({
    id: match[1],
    text: (match[2] || match[3] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    context,
  })).filter((item) => item.text);
}

export function applyFormulaRepairs(html, repairs) {
  let nextHtml = html;

  for (const repair of repairs || []) {
    if (!repair?.id || !repair?.mathMl) continue;
    const innerMath = repair.mathMl
      .replace(/^\s*<math[^>]*>/i, '')
      .replace(/<\/math>\s*$/i, '');
    const pattern = new RegExp(
      `<div class="formula-block" data-formula-id="${repair.id}"(?: data-formula-source="[^"]*")?>[\\s\\S]*?<\\/div>`,
      'g'
    );
    const originalMatch = nextHtml.match(
      new RegExp(`<div class="formula-block" data-formula-id="${repair.id}"(?: data-formula-source="([^"]*)")?>([\\s\\S]*?)<\\/div>`)
    );
    const originalSource = originalMatch?.[1] || originalMatch?.[2]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
    nextHtml = nextHtml.replace(
      pattern,
      `<div class="formula-block" data-formula-id="${repair.id}" data-formula-source="${escapeHtml(originalSource)}"><math xmlns="http://www.w3.org/1998/Math/MathML">${innerMath}</math></div>`
    );
  }

  return nextHtml;
}
