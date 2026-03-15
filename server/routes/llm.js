// ---------------------------------------------------------------------------
// LLM routes (summary + translation)  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { verifyTextAccess } from '../middleware/access.js';
import { checkTokenQuota } from '../middleware/tokenQuota.js';
import { aiLimiter, formulaRepairLimiter, pdfVisionLimiter } from '../middleware/rateLimits.js';
import { ALLOWED_LANGUAGES } from './texts.js';
import {
  getPagesByText,
  setTextSummary,
  setTextTranslation,
  getTextTranslation,
  updateText,
  saveTextHtml,
  getTextHtml,
  logApiUsage,
} from '../db.js';
import { generateSummary, translateText } from '../services/bedrock.js';
import { cleanupPdfHtml, parsePdfPageToHtml, repairFormulasToMathMl, extractFiguresFromPdf } from '../services/openrouter.js';
import { getTextDir } from '../services/storage.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const router = Router();

// All routes require authentication
router.use(requireAuth);

function requirePdfProject(project) {
  if (project.project_type !== 'pdf_to_html') {
    return { status: 400, error: 'This action is only available for PDF to HTML projects.' };
  }
  return {};
}

/**
 * Compile full text from all pages of a text.
 */
function compileFullText(textId) {
  const pages = getPagesByText(textId);
  return pages
    .filter((p) => p.ocr_text && p.filename !== '__compiled__')
    .map((p) => p.ocr_text)
    .join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Summary routes
// ---------------------------------------------------------------------------

// ---- GET /texts/:id/summary — return cached summary ---------------------
router.get('/texts/:id/summary', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    res.json({ summary: result.text.summary || null });
  } catch (err) {
    console.error('GET /texts/:id/summary error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/summary — generate summary via Bedrock -------------
router.post('/texts/:id/summary', aiLimiter, checkTokenQuota, async (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const fullText = compileFullText(result.text.id);
    if (!fullText) {
      return res.status(400).json({ error: 'No OCR text available. Run OCR first.' });
    }

    const summaryResult = await generateSummary(
      fullText,
      result.text.source_language || 'en'
    );
    const summary = summaryResult.text;

    setTextSummary(result.text.id, summary);
    logApiUsage(req.user.id, 'summary', process.env.BEDROCK_TEXT_MODEL, result.project.id, result.text.id, summaryResult.usage.tokensIn, summaryResult.usage.tokensOut);
    res.json({ summary });
  } catch (err) {
    console.error('POST /texts/:id/summary error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /texts/:id/summary — save manually-edited summary --------------
router.put('/texts/:id/summary', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { summary } = req.body || {};
    if (summary === undefined) {
      return res.status(400).json({ error: 'Summary content is required.' });
    }

    setTextSummary(result.text.id, summary);
    res.json({ summary });
  } catch (err) {
    console.error('PUT /texts/:id/summary error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Translation routes
// ---------------------------------------------------------------------------

// ---- GET /texts/:id/translation — return cached translation --------------
router.get('/texts/:id/translation', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const translation = getTextTranslation(result.text.id);
    res.json({
      translation: translation || null,
      source_language: result.text.source_language,
      target_language: result.text.target_language,
    });
  } catch (err) {
    console.error('GET /texts/:id/translation error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/translation — generate translation via Bedrock -----
router.post('/texts/:id/translation', aiLimiter, checkTokenQuota, async (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { targetLanguage } = req.body || {};
    if (!targetLanguage) {
      return res.status(400).json({ error: 'Target language is required.' });
    }

    // [MED-6] Validate target language code
    if (!ALLOWED_LANGUAGES.has(targetLanguage)) {
      return res.status(400).json({ error: 'Invalid target language code.' });
    }

    const fullText = compileFullText(result.text.id);
    if (!fullText) {
      return res.status(400).json({ error: 'No OCR text available. Run OCR first.' });
    }

    const sourceLang = result.text.source_language || 'auto-detect';

    const translateResult = await translateText(fullText, sourceLang, targetLanguage);
    const translation = translateResult.text;

    // Save translation and language info
    setTextTranslation(result.text.id, translation);
    updateText(result.text.id, { target_language: targetLanguage });
    logApiUsage(req.user.id, 'translation', process.env.BEDROCK_TEXT_MODEL, result.project.id, result.text.id, translateResult.usage.tokensIn, translateResult.usage.tokensOut);

    res.json({
      translation,
      source_language: sourceLang,
      target_language: targetLanguage,
    });
  } catch (err) {
    console.error('POST /texts/:id/translation error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /texts/:id/translation — save manually-edited translation ------
router.put('/texts/:id/translation', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { translation } = req.body || {};
    if (translation === undefined) {
      return res.status(400).json({ error: 'Translation content is required.' });
    }

    setTextTranslation(result.text.id, translation);
    res.json({ translation });
  } catch (err) {
    console.error('PUT /texts/:id/translation error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/formula-repair — convert formulas to MathML ---------
router.post('/texts/:id/formula-repair', formulaRepairLimiter, async (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requirePdfProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const { formulas, html_content } = req.body || {};
    if (!Array.isArray(formulas) || formulas.length === 0) {
      return res.status(400).json({ error: 'A non-empty formulas array is required.' });
    }
    if (formulas.length > 50) {
      return res.status(400).json({ error: 'Too many formulas in one request (max 50).' });
    }

    const repaired = await repairFormulasToMathMl(formulas);
    const currentHtml = getTextHtml(result.text.id);
    if (html_content !== undefined) {
      saveTextHtml(result.text.id, html_content, {
        sourcePdfName: currentHtml?.source_pdf_name || undefined,
        pdfMeta: currentHtml?.pdf_meta || undefined,
        formulaRepairStatus: repaired.length > 0 ? 'completed' : 'attempted',
      });
    }

    res.json({ formulas: repaired });
  } catch (err) {
    console.error('POST /texts/:id/formula-repair error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/texts/:id/pdf-parse-page', pdfVisionLimiter, checkTokenQuota, async (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requirePdfProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const { pdfBase64, imageBase64, textHint, pageNumber, totalPages } = req.body || {};
    const inputData = pdfBase64 || imageBase64;
    if (typeof inputData !== 'string' || inputData.length < 100) {
      return res.status(400).json({ error: 'A valid pdfBase64 or imageBase64 payload is required.' });
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ error: 'A valid pageNumber is required.' });
    }

    // Extract embedded figure images from the PDF page using pdftohtml -xml
    let figureAssets = [];
    if (pdfBase64) {
      try {
        const figures = await extractFiguresFromPdf(pdfBase64, pageNumber);
        if (figures.length > 0) {
          // Save extracted figures to the text's directory on disk
          const textDir = getTextDir(result.project.user_id, result.project.id, result.text.id);
          await mkdir(textDir, { recursive: true });
          for (const fig of figures) {
            await writeFile(join(textDir, fig.filename), fig.data);
            figureAssets.push({ filename: fig.filename, width: fig.width, height: fig.height });
          }
        }
      } catch (err) {
        console.warn('Figure extraction failed for page', pageNumber, ':', err.message);
        // Non-fatal — continue without figures
      }
    }

    const parsed = await parsePdfPageToHtml(
      inputData, pageNumber,
      Number.isInteger(totalPages) ? totalPages : null,
      textHint || '',
      figureAssets
    );

    // Log usage
    if (parsed.usage) {
      logApiUsage(req.user.id, 'pdf-parse', process.env.OPENROUTER_PDF_MODEL || 'gemini-3-flash', result.project.id, result.text.id, parsed.usage.tokensIn, parsed.usage.tokensOut);
    }

    // Include figure info in response so the client knows what was extracted
    res.json({ html: parsed.html, unresolvedFormulaCount: parsed.unresolvedFormulaCount, figureAssets });
  } catch (err) {
    console.error('POST /texts/:id/pdf-parse-page error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/texts/:id/pdf-cleanup', pdfVisionLimiter, async (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requirePdfProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const { html } = req.body || {};
    if (typeof html !== 'string' || !html.trim()) {
      return res.status(400).json({ error: 'HTML is required.' });
    }

    const cleanedHtml = await cleanupPdfHtml(html);
    res.json({ html: cleanedHtml });
  } catch (err) {
    console.error('POST /texts/:id/pdf-cleanup error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
