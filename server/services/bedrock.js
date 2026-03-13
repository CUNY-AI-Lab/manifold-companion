// ---------------------------------------------------------------------------
// AWS Bedrock integration — OCR, summary, translation
// ---------------------------------------------------------------------------

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

// ---------------------------------------------------------------------------
// Default OCR prompt
// ---------------------------------------------------------------------------

const DEFAULT_OCR_PROMPT = `You are an expert OCR system. This is a scan of a document page.

CRITICAL INSTRUCTIONS:
- The paper may be thin, so you may see faint text bleeding through from the OTHER SIDE. IGNORE reversed/mirrored or faint bleed-through text. Only transcribe the main text on THIS side.
- Transcribe the text EXACTLY as written, preserving the original language.
- The text may wrap at fixed margins. Do NOT preserve physical line breaks. Join lines in the same paragraph into continuous text. Only break where there is an actual paragraph break.
- Do NOT include page numbers.
- Do NOT add any commentary, headers, or footers.
- Do NOT repeat any text. If you have already transcribed a section, do not transcribe it again. Each paragraph should appear exactly once.

HANDLING UNCLEAR OR MODIFIED TEXT:
- Hard to read: [unclear: your best guess]
- Crossed out: [deleted: crossed out text]
- Handwritten annotations: [handwritten: the annotation text]
- Completely illegible: [illegible]

MARKDOWN FORMATTING:
- ## Heading for titles, centered headings, section headers
- **bold** for emphasized words or character names
- *italic* for stage directions, handwritten annotations, italic typeface
- --- for section separators
- Regular body text: no formatting

Output ONLY the transcribed text. No thinking or reasoning.`;

export { DEFAULT_OCR_PROMPT };

// ---------------------------------------------------------------------------
// Model format helpers
// ---------------------------------------------------------------------------

function isNovaModel(modelId) {
  return modelId && modelId.includes('amazon.nova');
}

function isClaudeModel(modelId) {
  return modelId && (modelId.includes('anthropic.claude') || modelId.includes('claude'));
}

function isQwenModel(modelId) {
  return modelId && modelId.includes('qwen.');
}

function isOpenAIModel(modelId) {
  return modelId && modelId.includes('openai.');
}

/**
 * Build the InvokeModel request body for a vision (OCR) call.
 */
function buildOcrBody(base64Image, prompt, modelId, temperature, maxTokens) {
  // Qwen VL and OpenAI models use OpenAI-compatible format
  if (isQwenModel(modelId) || isOpenAIModel(modelId)) {
    return JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: maxTokens,
      temperature,
    });
  }

  if (isNovaModel(modelId)) {
    return JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            {
              image: {
                format: 'jpeg',
                source: { bytes: base64Image },
              },
            },
            { text: prompt },
          ],
        },
      ],
      inferenceConfig: {
        maxTokens,
        temperature,
      },
    });
  }

  // Anthropic Claude on Bedrock format
  return JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  });
}

/**
 * Build the InvokeModel request body for a text-only call.
 */
function buildTextBody(systemPrompt, userText, modelId, temperature, maxTokens) {
  // OpenAI and Qwen models use OpenAI-compatible format
  if (isOpenAIModel(modelId) || isQwenModel(modelId)) {
    return JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      max_tokens: maxTokens,
      temperature,
    });
  }

  if (isNovaModel(modelId)) {
    return JSON.stringify({
      messages: [
        { role: 'user', content: [{ text: userText }] },
      ],
      system: [{ text: systemPrompt }],
      inferenceConfig: {
        maxTokens,
        temperature,
      },
    });
  }

  // Anthropic Claude on Bedrock format
  return JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
        ],
      },
    ],
  });
}

/**
 * Extract the assistant text from a Bedrock response body.
 */
function extractText(responseBody, modelId) {
  const parsed = JSON.parse(responseBody);
  let text = '';

  // OpenAI-compatible format (Qwen, GPT-OSS)
  if (isQwenModel(modelId) || isOpenAIModel(modelId)) {
    text = parsed.choices?.[0]?.message?.content || '';
  } else if (isNovaModel(modelId)) {
    text = parsed.output?.message?.content?.[0]?.text || '';
  } else if (parsed.content && Array.isArray(parsed.content)) {
    // Claude: { content: [{ type: 'text', text }] }
    const textBlock = parsed.content.find((b) => b.type === 'text');
    text = textBlock?.text || '';
  } else {
    text = parsed.completion || '';
  }

  // Strip model reasoning/thinking tags that leak into output
  return text.replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/gi, '')
             .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '')
             .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
             .trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run OCR on a single page image.
 *
 * @param {string} base64Image  Base64-encoded JPEG image
 * @param {object} settings     Optional overrides: { prompt, model, temperature, max_tokens }
 * @returns {string}            The transcribed text
 */
export async function ocrPage(base64Image, settings = {}) {
  const prompt = settings.prompt || DEFAULT_OCR_PROMPT;
  const modelId = settings.model || process.env.BEDROCK_OCR_MODEL;
  const temperature = settings.temperature ?? 0.1;
  const maxTokens = settings.max_tokens || 8192;

  if (!modelId) {
    throw new Error('No OCR model configured. Set BEDROCK_OCR_MODEL in .env');
  }

  const body = buildOcrBody(base64Image, prompt, modelId, temperature, maxTokens);

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const responseBody = new TextDecoder().decode(response.body);
  const rawText = extractText(responseBody, modelId);

  // Post-processing: collapse repetition loops
  return deduplicateOCR(rawText);
}

/**
 * Remove repetition loops from OCR output.
 *
 * Vision models sometimes enter a repetition loop where they repeat a phrase,
 * sentence, or paragraph hundreds of times. This function detects and collapses
 * those loops at two levels:
 *
 * 1. Paragraph-level: consecutive identical paragraphs (split by \n\n)
 * 2. Phrase-level: a repeating substring within a single paragraph
 */
function deduplicateOCR(text) {
  const paragraphs = text.split('\n\n');
  const dedupedParas = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (dedupedParas.length === 0 || dedupedParas[dedupedParas.length - 1] !== trimmed) {
      dedupedParas.push(trimmed);
    }
  }
  return dedupedParas.map(collapseRepeatingPhrases).join('\n\n');
}

/**
 * Detect and collapse a repeating phrase/sentence within a single text block.
 */
function collapseRepeatingPhrases(text, _depth = 0) {
  if (text.length < 80 || _depth > 20) return text;

  const maxIterations = 500_000;
  let iterations = 0;

  for (let patLen = Math.min(200, Math.floor(text.length / 3)); patLen >= 20; patLen--) {
    for (let start = 0; start <= text.length - patLen * 3; start++) {
      if (++iterations > maxIterations) return text;
      const pattern = text.substring(start, start + patLen);
      let count = 1;
      let pos = start + patLen;
      while (pos + patLen <= text.length && text.substring(pos, pos + patLen) === pattern) {
        count++;
        pos += patLen;
      }
      if (count >= 3) {
        const before = text.substring(0, start + patLen);
        const after = text.substring(pos);
        return collapseRepeatingPhrases(before + after, _depth + 1);
      }
    }
  }

  return text;
}

/**
 * Generate a concise summary of the full OCR text.
 */
export async function generateSummary(fullText, language = 'en') {
  const modelId = process.env.BEDROCK_TEXT_MODEL;
  if (!modelId) {
    throw new Error('No text model configured. Set BEDROCK_TEXT_MODEL in .env');
  }

  const truncated =
    fullText.length > 100000
      ? fullText.substring(0, 100000) + '\n\n[text truncated]'
      : fullText;

  const systemPrompt =
    'You are a literary analyst. Write a concise summary of approximately 200 words in English. ' +
    'Describe the genre, themes, characters, and narrative arc. ' +
    `The source text is in ${language}. Output only the summary text — no titles, headers, labels, or word counts.`;

  const body = buildTextBody(systemPrompt, truncated, modelId, 0.3, 1024);

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const responseBody = new TextDecoder().decode(response.body);
  return extractText(responseBody, modelId);
}

/**
 * Translate text between languages, chunking at ~10 KB boundaries.
 */
export async function translateText(text, sourceLang, targetLang) {
  const modelId = process.env.BEDROCK_TEXT_MODEL;
  if (!modelId) {
    throw new Error('No text model configured. Set BEDROCK_TEXT_MODEL in .env');
  }

  const systemPrompt =
    `You are a literary translator. Translate from ${sourceLang} to ${targetLang}. ` +
    'Preserve the original style, tone, and register. ' +
    'Keep paragraph breaks and page separators (---) intact. ' +
    'Output only the translated text.';

  const CHUNK_SIZE = 10 * 1024;
  const separator = '\n\n---\n\n';
  const sections = text.split(separator);

  const chunks = [];
  let current = '';

  for (const section of sections) {
    if (current.length + section.length + separator.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current);
      current = section;
    } else {
      current = current ? current + separator + section : section;
    }
  }
  if (current) {
    chunks.push(current);
  }

  const translated = [];
  for (const chunk of chunks) {
    const body = buildTextBody(systemPrompt, chunk, modelId, 0.3, 4096);

    const command = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const response = await client.send(command);
    const responseBody = new TextDecoder().decode(response.body);
    translated.push(extractText(responseBody, modelId));
  }

  return translated.join(separator);
}

function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model did not return valid JSON.');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function extractJsonPayload(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');

  if (objectStart !== -1 && objectEnd > objectStart && (arrayStart === -1 || objectStart < arrayStart)) {
    return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
  }
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
  }

  throw new Error('Model did not return valid JSON.');
}

function buildHtmlFromPageBlocks(pageNumber, blocks) {
  const chunks = [`<section data-page="${pageNumber}">`];

  for (const block of blocks || []) {
    if (!block || block.skip) continue;
    const type = String(block.type || '').toLowerCase();
    const text = typeof block.text === 'string' ? block.text.trim() : '';
    const html = typeof block.html === 'string' ? block.html.trim() : '';

    if (html) {
      chunks.push(html);
      continue;
    }

    if (!text) continue;

    if (type === 'heading') {
      const level = Math.min(3, Math.max(1, Number(block.level) || 2));
      chunks.push(`<h${level}>${escapeHtml(text)}</h${level}>`);
    } else if (type === 'formula') {
      const formulaId = block.id || `page-${pageNumber}-formula-${chunks.length}`;
      const mathMl = sanitizeMathMl(block.mathMl || '');
      if (mathMl) {
        const innerMath = mathMl.replace(/^\s*<math[^>]*>/i, '').replace(/<\/math>\s*$/i, '');
        chunks.push(
          `<div class="formula-block" data-formula-id="${formulaId}" data-formula-source="${escapeHtml(text)}">` +
          `<math xmlns="http://www.w3.org/1998/Math/MathML">${innerMath}</math></div>`
        );
      } else {
        chunks.push(
          `<div class="formula-block" data-formula-id="${formulaId}" data-formula-source="${escapeHtml(text)}">${escapeHtml(text)}</div>`
        );
      }
    } else if (type === 'toc_entry') {
      const pageLabel = block.page_label ? escapeHtml(String(block.page_label).trim()) : '';
      chunks.push(
        `<div class="toc-entry"><span class="toc-entry__title">${escapeHtml(text)}</span>` +
        `<span class="toc-entry__page">${pageLabel}</span></div>`
      );
    } else if (type === 'list_item') {
      chunks.push(`<li>${escapeHtml(text)}</li>`);
    } else if (type === 'table') {
      chunks.push(`<div class="table-block">${escapeHtml(text)}</div>`);
    } else {
      chunks.push(`<p>${escapeHtml(text)}</p>`);
    }
  }

  chunks.push('</section>');
  return chunks.join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeMathMl(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^```(?:xml)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

async function invokeFormulaRepairBatch(formulas, modelId) {
  const systemPrompt =
    'You convert mathematical expressions into valid presentation MathML. ' +
    'Return strict JSON only. Do not include markdown fences or commentary.';

  const payload = JSON.stringify({
    formulas: formulas.map((formula) => ({
      id: formula.id,
      text: formula.text,
      context: formula.context || '',
    })),
    instructions: [
      'Return {"formulas":[{"id":"...","mathMl":"...","confidence":"high|medium|low"}]}',
      'Use valid MathML elements only inside each mathMl field.',
      'Do not include explanations or prose.',
      'If a formula is ambiguous, still provide the best MathML you can and lower confidence.',
    ],
  });

  const body = buildTextBody(systemPrompt, payload, modelId, 0.1, 4096);
  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const responseBody = new TextDecoder().decode(response.body);
  const parsed = extractJsonObject(extractText(responseBody, modelId));
  const repaired = Array.isArray(parsed.formulas) ? parsed.formulas : [];

  return repaired
    .map((entry) => ({
      id: entry?.id,
      mathMl: sanitizeMathMl(entry?.mathMl),
      confidence: entry?.confidence || 'low',
    }))
    .filter((entry) => entry.id && entry.mathMl);
}

export async function repairFormulasToMathMl(formulas) {
  if (!Array.isArray(formulas) || formulas.length === 0) {
    return [];
  }

  const modelId = process.env.BEDROCK_FORMULA_MODEL
    || process.env.BEDROCK_TEXT_MODEL
    || 'anthropic.claude-sonnet-4-20250514-v1:0';

  try {
    return await invokeFormulaRepairBatch(formulas, modelId);
  } catch (err) {
    console.warn('Formula repair batch failed, retrying with smaller batches:', err.message);
  }

  if (formulas.length === 1) {
    return [];
  }

  const midpoint = Math.ceil(formulas.length / 2);
  const left = await repairFormulasToMathMl(formulas.slice(0, midpoint));
  const right = await repairFormulasToMathMl(formulas.slice(midpoint));
  return [...left, ...right];
}

async function invokeVisionJson(base64Image, prompt, modelId, maxTokens = 4096) {
  const body = buildOcrBody(base64Image, prompt, modelId, 0.1, maxTokens);
  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const responseBody = new TextDecoder().decode(response.body);
  return extractJsonPayload(extractText(responseBody, modelId));
}

function stripHtmlText(html) {
  return String(html || '')
    .replace(/<math[\s\S]*?<\/math>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function parsePdfPageToHtml(base64Image, pageNumber, totalPages = null) {
  const modelId =
    process.env.BEDROCK_PDF_VISION_MODEL
    || process.env.BEDROCK_OCR_MODEL
    || 'qwen.qwen3-vl-235b-a22b';

  const prompt =
    'You are a document-layout parser for textbook PDF pages. Return strict JSON only. ' +
    'Your job is to transcribe the entire visible page into semantic HTML in correct reading order. ' +
    'Never omit real page content. Ignore only running headers, page numbers, and footer boilerplate. ' +
    'Preserve headings, lists, examples, tables, and formulas. ' +
    'For formulas, wrap them as <div class="formula-block" data-formula-id="... " data-formula-source="...">...</div>. ' +
    'If you can express a formula in presentation MathML, place <math xmlns="http://www.w3.org/1998/Math/MathML">...</math> inside the formula-block. ' +
    'If you cannot produce MathML confidently, still emit the exact formula text inside the formula-block. ' +
    'For table-of-contents pages, use <div class="toc-entry"><span class="toc-entry__title">...</span><span class="toc-entry__page">...</span></div> per entry. ' +
    'Use only h1, h2, h3, p, ol, ul, li, table, thead, tbody, tr, th, td, blockquote, div.formula-block, div.toc-entry, span.toc-entry__title, span.toc-entry__page. ' +
    JSON.stringify({
      task: 'parse_page_to_html',
      page_number: pageNumber,
      total_pages: totalPages,
      output_schema: {
        html: '<section data-page="N">...</section>',
        stats: {
          contains_text: true,
          contains_formula: false,
          contains_toc: false,
        },
      },
      rules: [
        'Never return an empty section if the page contains readable content.',
        'Do not collapse formulas into nearby prose paragraphs.',
        'Do not turn ordinary wrapped sentences into headings.',
        'Example titles and section titles should be headings.',
      ],
    });

  const parsed = await invokeVisionJson(base64Image, prompt, modelId, 8000);
  let html = typeof parsed?.html === 'string' ? parsed.html.trim() : '';
  if (!/^<section\b/i.test(html)) {
    html = `<section data-page="${pageNumber}">\n${html}\n</section>`;
  }

  if (stripHtmlText(html).length < 80) {
    const fallbackPrompt =
      'Transcribe this textbook PDF page into semantic HTML in correct reading order. Return strict JSON only. ' +
      'Keep all real page content except running header/footer artifacts. ' +
      'Use <section data-page="' + pageNumber + '"> as the root and preserve headings, paragraphs, lists, and formulas. ' +
      'Formulas must be emitted as <div class="formula-block" data-formula-id="..." data-formula-source="...">...</div> with MathML inside when possible. ' +
      'Return {"html":"..."} only.';
    const fallback = await invokeVisionJson(base64Image, fallbackPrompt, modelId, 8000);
    const fallbackHtml = typeof fallback?.html === 'string' ? fallback.html.trim() : '';
    if (stripHtmlText(fallbackHtml).length > stripHtmlText(html).length) {
      html = /^<section\b/i.test(fallbackHtml)
        ? fallbackHtml
        : `<section data-page="${pageNumber}">\n${fallbackHtml}\n</section>`;
    }
  }

  const unresolvedFormulaCount = (html.match(/class="formula-block"/g) || []).length - (html.match(/<math\b/g) || []).length;

  return {
    html,
    unresolvedFormulaCount,
  };
}

export async function cleanupPdfHtml(html) {
  const modelId =
    process.env.BEDROCK_PDF_CLEANUP_MODEL
    || 'qwen.qwen3-next-80b-a3b';

  const sections = html.match(/<section\b[\s\S]*?<\/section>/g) || [];
  if (!sections.length) return html;

  const systemPrompt =
    'You are a semantic HTML editor for textbook documents. ' +
    'Clean up the provided HTML without changing meaning. ' +
    'Preserve MathML, formula-block divs, toc-entry divs, and section boundaries. ' +
    'Improve heading hierarchy, merge paragraph fragments, and keep TOC entries separate. ' +
    'Return strict JSON only.';

  const cleanedSections = [];

  for (const chunk of sections) {
    const originalText = stripHtmlText(chunk);
    const userText = JSON.stringify({
      html: chunk,
      instructions: [
        'Keep existing section data-page attributes.',
        'Do not drop page content.',
        'Promote only true headings.',
        'Do not invent text or formulas.',
        'Do not remove MathML.',
        'Preserve formula-block and toc-entry markup.',
        'Return {"html":"..."} only.',
      ],
    });

    const body = buildTextBody(systemPrompt, userText, modelId, 0.1, 8192);
    const command = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const response = await client.send(command);
    const responseBody = new TextDecoder().decode(response.body);
    const parsed = extractJsonPayload(extractText(responseBody, modelId));
    if (!parsed?.html || typeof parsed.html !== 'string') {
      cleanedSections.push(chunk);
      continue;
    }
    const cleaned = parsed.html
      .trim()
      .replace(/^<article[^>]*>\s*/i, '')
      .replace(/\s*<\/article>\s*$/i, '');
    const cleanedText = stripHtmlText(cleaned);
    const retainedEnough = cleanedText.length >= Math.max(40, originalText.length * 0.65);
    cleanedSections.push(retainedEnough ? cleaned : chunk);
  }

  return `<article class="pdf-html-document">\n${cleanedSections.join('\n')}\n</article>`;
}
