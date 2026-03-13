// ---------------------------------------------------------------------------
// OpenRouter integration — PDF page parsing, HTML cleanup
// Sends native PDF pages to Gemini. TeX math is converted to MathML via temml.
// ---------------------------------------------------------------------------

import temml from 'temml';

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
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .trim();
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
- Printed mathematics must use TeX delimiters: \\(...\\) for inline math, \\[...\\] for display math
- Do NOT use MathML. Do NOT use <math> tags. Use TeX only.
- For diagrams, charts, graphs, or photos: use <figure><img src="page-PAGE_NUMBER.jpg" alt="Description of the visual"><figcaption>Description of the visual</figcaption></figure>
- Replace PAGE_NUMBER with the current page number in the img src
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

export async function parsePdfPageToHtml(pdfBase64, pageNumber, totalPages, textHint) {
  const userParts = [
    `Convert this PDF page to semantic HTML. This is page ${pageNumber}` +
    (totalPages ? ` of ${totalPages}` : '') + '.',
    `Wrap output in <section data-page="${pageNumber}">.`,
    'Use \\\\(...\\\\) for inline math and \\\\[...\\\\] for display math.',
  ];

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

  const raw = await callWithRetry(() => callOpenRouter(messages, { maxTokens: 4096 }));
  let html = postprocessHtml(extractHtmlFromResponse(raw), pageNumber);

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

    const fallbackRaw = await callWithRetry(() => callOpenRouter(fallbackMessages, { maxTokens: 4096 }));
    const fallbackHtml = postprocessHtml(extractHtmlFromResponse(fallbackRaw), pageNumber);
    if (stripHtmlText(fallbackHtml).length > stripHtmlText(html).length) {
      html = /^<section\b/i.test(fallbackHtml)
        ? fallbackHtml
        : `<section data-page="${pageNumber}">\n${fallbackHtml}\n</section>`;
    }
  }

  return { html, unresolvedFormulaCount: 0 };
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

function convertTexToMathML(html) {
  // Display math: \[...\]
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (match, tex) => {
    try {
      return temml.renderToString(tex.trim(), { displayMode: true });
    } catch {
      // If temml can't parse it, leave the TeX as-is in a fallback span
      return `<span class="math-fallback" title="TeX parse error">${escapeHtml(match)}</span>`;
    }
  });

  // Inline math: \(...\)
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (match, tex) => {
    try {
      return temml.renderToString(tex.trim(), { displayMode: false });
    } catch {
      return `<span class="math-fallback" title="TeX parse error">${escapeHtml(match)}</span>`;
    }
  });

  return html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// cleanupPdfHtml — normalize structure, convert TeX→MathML, wrap in article.
// No LLM cleanup pass — the per-page output from Gemini is good enough.
// We only do deterministic structural normalization + math conversion.
// ---------------------------------------------------------------------------

export async function cleanupPdfHtml(html) {
  let result = normalizeCalloutBoxes(html);
  result = convertTexToMathML(result);
  if (/<article\b/i.test(result)) return result;
  return `<article class="pdf-html-document">\n${result}\n</article>`;
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
