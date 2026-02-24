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

/**
 * Determine whether a model ID is Amazon Nova or Anthropic Claude (or other).
 */
function isNovaModel(modelId) {
  return modelId && modelId.includes('amazon.nova');
}

function isClaudeModel(modelId) {
  return modelId && (modelId.includes('anthropic.claude') || modelId.includes('claude'));
}

/**
 * Build the InvokeModel request body for a vision (OCR) call.
 */
function buildOcrBody(base64Image, prompt, modelId, temperature, maxTokens) {
  if (isNovaModel(modelId)) {
    // Amazon Nova format
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

  if (isNovaModel(modelId)) {
    // Nova: { output: { message: { content: [{ text }] } } }
    return parsed.output?.message?.content?.[0]?.text || '';
  }

  // Claude: { content: [{ type: 'text', text }] }
  if (parsed.content && Array.isArray(parsed.content)) {
    const textBlock = parsed.content.find((b) => b.type === 'text');
    return textBlock?.text || '';
  }

  return parsed.completion || '';
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
  const maxTokens = settings.max_tokens || 4096;

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
  return extractText(responseBody, modelId);
}

/**
 * Generate a concise summary of the full OCR text.
 *
 * @param {string} fullText    The compiled OCR text
 * @param {string} language    Source language code (default 'en')
 * @returns {string}           Summary text
 */
export async function generateSummary(fullText, language = 'en') {
  const modelId = process.env.BEDROCK_TEXT_MODEL;
  if (!modelId) {
    throw new Error('No text model configured. Set BEDROCK_TEXT_MODEL in .env');
  }

  // Truncate very long texts to avoid token limits
  const truncated =
    fullText.length > 100000
      ? fullText.substring(0, 100000) + '\n\n[text truncated]'
      : fullText;

  const systemPrompt =
    'You are a literary analyst. Write a concise summary of approximately 200 words in English. ' +
    'Describe the genre, themes, characters, and narrative arc. ' +
    `The source text is in ${language}. Output only the summary.`;

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
 *
 * @param {string} text         The text to translate
 * @param {string} sourceLang   Source language name or code
 * @param {string} targetLang   Target language name or code
 * @returns {string}            Translated text
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

  // Split text into chunks at page-separator boundaries (~10 KB each)
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

  // Translate each chunk
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
