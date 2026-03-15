// ---------------------------------------------------------------------------
// OpenRouter integration — PDF page parsing, HTML cleanup
// Sends native PDF pages to Gemini. TeX math is converted to MathML via temml.
// Figure assets are extracted from embedded PDF images via pdftohtml -xml.
// ---------------------------------------------------------------------------

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, readdir, unlink, mkdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import temml from 'temml';

const execFileAsync = promisify(execFile);

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

function getApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set in .env');
  return key;
}

function getModel() {
  return process.env.OPENROUTER_PDF_MODEL || 'google/gemini-3-flash-preview';
}

// ---------------------------------------------------------------------------
// Core HTTP caller
// ---------------------------------------------------------------------------

async function callOpenRouter(messages, { temperature = 0, maxTokens = 4096 } = {}) {
  const res = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://tools.cuny.qzz.io/manifold-companion/',
      'X-Title': 'CAIL Manifold Companion',
    },
    body: JSON.stringify({
      model: getModel(),
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const usage = {
    tokensIn: data.usage?.prompt_tokens || 0,
    tokensOut: data.usage?.completion_tokens || 0,
  };
  const cleaned = text
    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .trim();
  return { text: cleaned, usage };
}

// ---------------------------------------------------------------------------
// Retry wrapper — exponential backoff on 429/5xx
// ---------------------------------------------------------------------------

async function callWithRetry(fn, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = parseInt(err.message?.match(/OpenRouter (\d+)/)?.[1], 10);
      const retryable = status === 429 || status === 408 || status === 409 ||
        status === 425 || (status >= 500 && status < 600);
      if (!retryable || attempt === maxRetries) throw err;
      const delay = Math.min(2000 * 2 ** attempt, 30000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Figure extraction — uses pdftohtml -xml to extract embedded images
// ---------------------------------------------------------------------------

/**
 * Extract embedded figure images from a single-page PDF using pdftohtml -xml.
 * Returns an array of { filename, width, height, data (Buffer) }.
 * Filters out tiny images (< 40px wide/tall or < 2500 area).
 */
export async function extractFiguresFromPdf(pdfBase64, pageNumber) {
  const id = randomBytes(8).toString('hex');
  const workDir = join(tmpdir(), `mc-figures-${id}`);
  const pdfPath = join(workDir, 'page.pdf');

  try {
    await mkdir(workDir, { recursive: true });

    // Write the base64 PDF to a temp file
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    await writeFile(pdfPath, pdfBuffer);

    // Run pdftohtml -xml to extract layout + images
    const xmlBase = join(workDir, 'layout');
    try {
      await execFileAsync('pdftohtml', ['-xml', '-f', '1', '-l', '1', pdfPath, xmlBase], {
        timeout: 15000,
      });
    } catch (err) {
      // pdftohtml may not be installed or may fail on certain PDFs
      console.warn('pdftohtml figure extraction failed:', err.message);
      return [];
    }

    // Read the XML output
    const xmlPath = xmlBase + '.xml';
    let xmlContent;
    try {
      xmlContent = await readFile(xmlPath, 'utf-8');
    } catch {
      return [];
    }

    // Parse image nodes from the XML
    const imageRegex = /<image\s+([^>]+)>/gi;
    const figures = [];
    let figureIndex = 0;
    let match;

    while ((match = imageRegex.exec(xmlContent)) !== null) {
      const attrs = match[1];
      const width = parseInt(attrs.match(/width="(\d+)"/)?.[1] || '0', 10);
      const height = parseInt(attrs.match(/height="(\d+)"/)?.[1] || '0', 10);
      const src = attrs.match(/src="([^"]+)"/)?.[1];

      // Filter out tiny images (icons, bullets, decorations)
      if (width < 40 || height < 40 || width * height < 2500) continue;
      if (!src) continue;

      // Read the extracted image file (src may be absolute or relative)
      const imgPath = src.startsWith('/') ? src : join(workDir, src);
      let imgData;
      try {
        imgData = await readFile(imgPath);
      } catch {
        continue;
      }

      figureIndex++;
      const ext = src.split('.').pop() || 'png';
      const filename = `page-${String(pageNumber).padStart(3, '0')}-figure-${String(figureIndex).padStart(2, '0')}.${ext}`;

      figures.push({ filename, width, height, data: imgData });
    }

    return figures;
  } finally {
    // Clean up temp directory
    try { await rm(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// HTML extraction + postprocessing (minimal, like the working pipeline)
// ---------------------------------------------------------------------------

function extractHtmlFromResponse(text) {
  // Strip markdown fences
  let cleaned = text.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Try to find a <section> block
  const sectionMatch = cleaned.match(/<section[\s\S]*<\/section>/i);
  if (sectionMatch) return sectionMatch[0];

  return cleaned;
}

function postprocessHtml(html, pageNumber) {
  let result = html
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/\s*```$/i, '')
    // Strip <style> blocks
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Strip remaining inline styles
    .replace(/\s+style="[^"]*"/gi, '');

  // Ensure the top-level section has data-page
  if (pageNumber != null && !/data-page=/.test(result)) {
    result = result.replace(/<section\b/i, `<section data-page="${pageNumber}"`);
  }

  return result.trim();
}

function stripHtmlText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\[\(\)\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// parsePdfPageToHtml — native PDF input, TeX math output
// Matches the working pipeline: simple prompt, semantic HTML, TeX delimiters
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_PARSE = `You are a PDF page to semantic HTML converter.

Output exactly one top-level <section data-page="PAGE_NUMBER"> element containing the page content.

Rules:
- Use semantic HTML tags: h1, h2, h3, h4, p, ul, ol, li, table, thead, tbody, tr, th, td, blockquote, aside, section, header, footer, figure, figcaption, nav, strong, em, sup, sub, span
- Preserve ALL visible text in correct reading order
- Skip running headers, running footers, and page numbers (unless they are meaningful content)
- Mathematics MUST use TeX delimiters — never MathML or <math> tags:
  - Inline math: \\(...\\) for variables and expressions within a sentence
  - Display math: \\[...\\] for standalone equations, centered formulas, or anything on its own line
  - IMPORTANT: always match delimiters — \\( must close with \\), and \\[ must close with \\]. Never mix them.
- For multi-column equation layouts (e.g. numbered equations with equation numbers on the right, or aligned equation/answer pairs), use a borderless table: <table class="equation-table"><tr><td>\\[...\\]</td><td>(1)</td></tr></table>. This preserves the visual alignment from the PDF.
- For diagrams, charts, graphs, or photos: use ONLY the extracted figure filenames provided in the prompt. Do NOT invent image filenames.
- If no figure assets are listed, do NOT use any <img> tags. Use <figure><figcaption>[Description of the visual]</figcaption></figure> instead.
- Do NOT invent formulas from graphs — describe the graph instead
- No CSS, no inline styles, no JavaScript
- No <html>, <body>, <head> wrappers
- Return ONLY the HTML. No markdown fences. No commentary.

Structural rules for visual formatting — reproduce the PDF's visual structure:
- Any boxed, shaded, bordered, or visually distinct block in the PDF (examples, callouts, sidebars, tips, warnings, exercises, definitions, theorems, etc.) MUST be wrapped in a container element. Use: <section><header><h3>Title</h3></header>...content...</section> for most callout boxes, <aside><h3>Title</h3>...content...</aside> for secondary/sidebar content, <blockquote><h3>Title</h3>...content...</blockquote> for quoted or formal statements.
- Be CONSISTENT: if a type of box appears multiple times (e.g. "Example 1", "Example 2"), use the SAME tag pattern for ALL of them. Do not switch between bare headers and section-wrapped headers across pages.
- NEVER use a bare <header> element as a direct child of the page section. Every <header> must be inside a <section> wrapper.
- Copyright or license notices: wrap in <footer>
- Table of contents or navigation lists: wrap in <nav>
- Indented or offset blocks that are visually distinct from body text should be wrapped in a container, not left as loose paragraphs.`;

export async function parsePdfPageToHtml(pdfBase64, pageNumber, totalPages, textHint, figureAssets = []) {
  const userParts = [
    `Convert this PDF page to semantic HTML. This is page ${pageNumber}` +
    (totalPages ? ` of ${totalPages}` : '') + '.',
    `Wrap output in <section data-page="${pageNumber}">.`,
    'Use \\\\(...\\\\) for inline math and \\\\[...\\\\] for display math.',
  ];

  // Figure asset inventory — tell the model exactly which images exist
  if (figureAssets.length > 0) {
    userParts.push(
      '',
      'Extracted figure assets for this page (use ONLY these filenames for <img> tags):',
    );
    for (const fig of figureAssets) {
      userParts.push(`  - ${fig.filename} (${fig.width}×${fig.height}px)`);
    }
    userParts.push('Do not reference any other image filenames.');
  } else {
    userParts.push(
      '',
      'No figure assets were extracted for this page. Do not use any <img> tags.',
    );
  }

  if (textHint && textHint.trim().length > 20) {
    userParts.push(
      '',
      'Extracted text layer (use as a reference — the PDF rendering is authoritative):',
      textHint.slice(0, 8000)
    );
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT_PARSE },
    {
      role: 'user',
      content: [
        { type: 'text', text: userParts.join('\n') },
        {
          type: 'file',
          file: {
            filename: `page-${pageNumber}.pdf`,
            file_data: `data:application/pdf;base64,${pdfBase64}`,
          },
        },
      ],
    },
  ];

  const result = await callWithRetry(() => callOpenRouter(messages, { maxTokens: 4096 }));
  let totalUsage = { tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut };
  let html = postprocessHtml(extractHtmlFromResponse(result.text), pageNumber);

  if (!/^<section\b/i.test(html)) {
    html = `<section data-page="${pageNumber}">\n${html}\n</section>`;
  }

  // Fallback if response is suspiciously short
  if (stripHtmlText(html).length < 40) {
    const fallbackMessages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Transcribe this PDF page into semantic HTML. Wrap in <section data-page="${pageNumber}">. Use \\(...\\) for inline math and \\[...\\] for display math. No MathML. No CSS. Return only the HTML.`,
          },
          {
            type: 'file',
            file: {
              filename: `page-${pageNumber}.pdf`,
              file_data: `data:application/pdf;base64,${pdfBase64}`,
            },
          },
        ],
      },
    ];

    const fallbackResult = await callWithRetry(() => callOpenRouter(fallbackMessages, { maxTokens: 4096 }));
    totalUsage.tokensIn += fallbackResult.usage.tokensIn;
    totalUsage.tokensOut += fallbackResult.usage.tokensOut;
    const fallbackHtml = postprocessHtml(extractHtmlFromResponse(fallbackResult.text), pageNumber);
    if (stripHtmlText(fallbackHtml).length > stripHtmlText(html).length) {
      html = /^<section\b/i.test(fallbackHtml)
        ? fallbackHtml
        : `<section data-page="${pageNumber}">\n${fallbackHtml}\n</section>`;
    }
  }

  return { html, unresolvedFormulaCount: 0, usage: totalUsage };
}

// ---------------------------------------------------------------------------
// normalizeCalloutBoxes — fix inconsistent Gemini output
// Wraps orphaned <header> elements (direct children of section[data-page]
// that aren't inside a nested <section>) by collecting the header + following
// siblings until the next block-level boundary into a <section> wrapper.
// This is content-agnostic — works for any PDF type.
// ---------------------------------------------------------------------------

function normalizeCalloutBoxes(html) {
  // Process each page section independently
  html = html.replace(
    /(<section[^>]*data-page[^>]*>)([\s\S]*?)(<\/section>)/gi,
    (match, openTag, innerHtml, closeTag) => {
      return openTag + wrapOrphanedHeaders(innerHtml) + closeTag;
    }
  );

  return html;
}

function wrapOrphanedHeaders(innerHtml) {
  // Split into tokens: tags and text nodes
  // Look for <header>...</header> that aren't preceded by <section>
  // and wrap them + following content into <section>...</section>

  // Simple approach: split by lines/blocks and detect orphaned headers
  const lines = innerHtml.split('\n');
  const result = [];
  let inOrphanBlock = false;
  let orphanDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if this line starts an orphaned <header> (not inside a <section>)
    if (/^<header>/i.test(trimmed) && !inOrphanBlock) {
      // Look back to see if previous non-empty line opened a <section>
      let prevSignificant = '';
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j].trim()) { prevSignificant = lines[j].trim(); break; }
      }
      const isOrphaned = !/<section\b/i.test(prevSignificant);

      if (isOrphaned) {
        inOrphanBlock = true;
        orphanDepth = 0;
        result.push('  <section>');
        result.push(line);
        continue;
      }
    }

    if (inOrphanBlock) {
      // Track nesting to know when to close
      const opens = (line.match(/<section\b/gi) || []).length;
      const closes = (line.match(/<\/section>/gi) || []).length;
      orphanDepth += opens - closes;

      // Check if we've hit the next sibling-level element
      const isNextBlock = orphanDepth <= 0 && (
        /^<header>/i.test(trimmed) ||
        /^<section\b/i.test(trimmed) ||
        /^<h[12]\b/i.test(trimmed) ||
        /^<aside\b/i.test(trimmed) ||
        /^<blockquote\b/i.test(trimmed) ||
        /^<footer\b/i.test(trimmed) ||
        /^<nav\b/i.test(trimmed)
      );

      if (isNextBlock) {
        result.push('  </section>');
        inOrphanBlock = false;
        result.push(line);
      } else {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }

  if (inOrphanBlock) {
    result.push('  </section>');
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// convertTexToMathML — replace TeX delimiters with native MathML via temml
// Runs after all pages are assembled, before wrapping in article.
// ---------------------------------------------------------------------------

function isSubstantialMath(tex) {
  // Don't promote trivially short expressions (single variables, simple symbols)
  // Only promote expressions that look like real equations/formulas
  const trimmed = tex.trim();
  if (trimmed.length < 4) return false; // single vars like "f", "h", "a"
  // Must contain an operator, fraction, relation, or other "equation-like" content
  return /[=<>+\-*/]|\\(?:frac|sqrt|sum|prod|int|lim|cdot|times|div|pm|mp|leq|geq|neq|approx|equiv|sim|to|infty|left|right|begin|end)/.test(trimmed);
}

function promoteInlineToDisplay(html) {
  // Pre-conversion: promote \(...\) to \[...\] when it's clearly a standalone equation.
  // Pattern: a <p> (or <td>) whose only meaningful content is a single \(...\) expression.
  // Guard: only promote substantial math (equations), not single variables.
  html = html.replace(
    /(<(?:p|td)[^>]*>)\s*\\\(([\s\S]*?)\\\)\s*(<\/(?:p|td)>)/gi,
    (match, open, tex, close) => {
      if (!isSubstantialMath(tex)) return match;
      return `${open}\\[${tex}\\]${close}`;
    }
  );
  // Also promote when the line is just \(...\) possibly with an equation number like (1)
  html = html.replace(
    /(<(?:p|td)[^>]*>)\s*\\\(([\s\S]*?)\\\)\s*(\(\d+\))?\s*(<\/(?:p|td)>)/gi,
    (match, open, tex, eqNum, close) => {
      if (!isSubstantialMath(tex)) return match;
      const suffix = eqNum ? ` ${eqNum}` : '';
      return `${open}\\[${tex}\\]${suffix}${close}`;
    }
  );
  return html;
}

function convertTexToMathML(html) {
  // First promote obviously-display inline math to display
  html = promoteInlineToDisplay(html);

  // First pass: fix mismatched delimiters (\[...\) or \(...\]) before conversion
  html = html.replace(/\\\[([^]*?)\\\)/g, (match, tex) => {
    // \[ opened but \) closed — treat as display if short, else leave alone
    if (tex.length < 500 && !/<\/(?:p|section|div|article|table)\b/i.test(tex)) {
      return `\\[${tex}\\]`;
    }
    return match;
  });
  html = html.replace(/\\\(([^]*?)\\\]/g, (match, tex) => {
    // \( opened but \] closed — treat as inline if short, else leave alone
    if (tex.length < 500 && !/<\/(?:p|section|div|article|table)\b/i.test(tex)) {
      return `\\(${tex}\\)`;
    }
    return match;
  });

  // Display math: \[...\]
  // Guard: refuse matches that cross block-level HTML boundaries
  // Also demote trivial expressions (single variables) to inline
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (match, tex) => {
    if (tex.length > 2000 || /<\/(?:p|section|div|article|table|header|footer)\b/i.test(tex)) {
      return match; // false positive — mismatched delimiters spanning blocks
    }
    const trimmed = tex.trim();
    const useDisplay = isSubstantialMath(trimmed);
    try {
      let mathml = temml.renderToString(trimmed, { displayMode: useDisplay });
      if (!useDisplay) {
        mathml = mathml.replace(/^<math(?:\s+display="[^"]*")?/, '<math display="inline"');
        return `<span class="math-inline">${mathml}</span>`;
      }
      return mathml;
    } catch {
      return `<span class="math-fallback" title="TeX parse error">${escapeHtml(match)}</span>`;
    }
  });

  // Inline math: \(...\)
  // Guard: refuse matches that cross block-level HTML boundaries
  // Wrap in <span> to force inline rendering (browsers render bare <math> as block in contenteditable)
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (match, tex) => {
    if (tex.length > 1000 || /<\/(?:p|section|div|article|table|header|footer)\b/i.test(tex)) {
      return match;
    }
    try {
      let mathml = temml.renderToString(tex.trim(), { displayMode: false });
      mathml = mathml.replace(/^<math(?!\s+display=)/, '<math display="inline"');
      return `<span class="math-inline">${mathml}</span>`;
    } catch {
      return `<span class="math-fallback" title="TeX parse error">${escapeHtml(match)}</span>`;
    }
  });

  // Post-conversion: promote any inline math that is the sole child of a <p>
  // to display="block" — but only for substantial math, not single variables
  html = html.replace(
    /(<p[^>]*>)\s*(?:<span class="math-inline">)?(<math display="inline")([\s\S]*?<\/math>)(?:<\/span>)?\s*(<\/p>)/gi,
    (match, pOpen, mathOpen, rest, pClose) => {
      const textContent = rest.replace(/<[^>]+>/g, '').trim();
      if (textContent.length < 4) return match;
      return `${pOpen}<math display="block"${rest}${pClose}`;
    }
  );

  return html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// cleanupPdfHtml — normalize structure, wrap in article.
// TeX stays as-is (\(...\) and \[...\]) — rendered client-side by KaTeX.
// MathML conversion happens only at Manifold export time.
// ---------------------------------------------------------------------------

export async function cleanupPdfHtml(html) {
  let result = normalizeCalloutBoxes(html);
  if (/<article\b/i.test(result)) return result;
  return `<article class="pdf-html-document">\n${result}\n</article>`;
}

// ---------------------------------------------------------------------------
// convertTexToMathML — exported for use at Manifold export time only.
// Called by the export route, NOT during page parsing/cleanup.
// ---------------------------------------------------------------------------

export function convertHtmlTexToMathML(html) {
  // Fix mismatched delimiters first
  html = html.replace(/\\\[([^]*?)\\\)/g, (match, tex) => {
    if (tex.length < 500 && !/<\/(?:p|section|div|article|table)\b/i.test(tex)) {
      return `\\[${tex}\\]`;
    }
    return match;
  });
  html = html.replace(/\\\(([^]*?)\\\]/g, (match, tex) => {
    if (tex.length < 500 && !/<\/(?:p|section|div|article|table)\b/i.test(tex)) {
      return `\\(${tex}\\)`;
    }
    return match;
  });

  // Display math: \[...\]
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (match, tex) => {
    if (tex.length > 2000 || /<\/(?:p|section|div|article|table|header|footer)\b/i.test(tex)) {
      return match;
    }
    try {
      return temml.renderToString(tex.trim(), { displayMode: true });
    } catch {
      return match; // leave TeX as-is if temml fails
    }
  });

  // Inline math: \(...\)
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (match, tex) => {
    if (tex.length > 1000 || /<\/(?:p|section|div|article|table|header|footer)\b/i.test(tex)) {
      return match;
    }
    try {
      let mathml = temml.renderToString(tex.trim(), { displayMode: false });
      mathml = mathml.replace(/^<math(?!\s+display=)/, '<math display="inline"');
      return mathml;
    } catch {
      return match;
    }
  });

  return html;
}

// ---------------------------------------------------------------------------
// repairFormulasToMathMl — kept for API compatibility but unlikely to be needed
// with TeX output (MathJax renders TeX directly)
// ---------------------------------------------------------------------------

export async function repairFormulasToMathMl(formulas) {
  if (!Array.isArray(formulas) || formulas.length === 0) {
    return [];
  }
  return [];
}
