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
