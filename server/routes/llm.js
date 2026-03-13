// ---------------------------------------------------------------------------
// LLM routes (summary + translation)  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { aiLimiter, formulaRepairLimiter, pdfVisionLimiter } from '../middleware/rateLimits.js';
import { ALLOWED_LANGUAGES } from './texts.js';
import {
  getTextById,
  getProjectById,
  getPagesByText,
  setTextSummary,
  setTextTranslation,
  getTextTranslation,
  updateText,
  saveTextHtml,
  getTextHtml,
} from '../db.js';
import { generateSummary, translateText } from '../services/bedrock.js';
import { cleanupPdfHtml, parsePdfPageToHtml, repairFormulasToMathMl } from '../services/openrouter.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Ownership helper
// ---------------------------------------------------------------------------

function verifyTextOwnership(textId, userId) {
  const text = getTextById(textId);
  if (!text) {
    return { status: 404, error: 'Text not found.' };
  }

  const project = getProjectById(text.project_id);
  if (!project || project.user_id !== userId) {
    return { status: 403, error: 'Access denied.' };
  }

  return { text, project };
}

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
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    res.json({ summary: result.text.summary || null });
  } catch (err) {
    console.error('GET /texts/:id/summary error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/summary — generate summary via Bedrock -------------
router.post('/texts/:id/summary', aiLimiter, async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const fullText = compileFullText(result.text.id);
    if (!fullText) {
      return res.status(400).json({ error: 'No OCR text available. Run OCR first.' });
    }

    const summary = await generateSummary(
      fullText,
      result.text.source_language || 'en'
    );

    setTextSummary(result.text.id, summary);
    res.json({ summary });
  } catch (err) {
    console.error('POST /texts/:id/summary error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /texts/:id/summary — save manually-edited summary --------------
router.put('/texts/:id/summary', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
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
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
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
router.post('/texts/:id/translation', aiLimiter, async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
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

    const translation = await translateText(fullText, sourceLang, targetLanguage);

    // Save translation and language info
    setTextTranslation(result.text.id, translation);
    updateText(result.text.id, { target_language: targetLanguage });

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
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
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
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
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

router.post('/texts/:id/pdf-parse-page', pdfVisionLimiter, async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
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

    const parsed = await parsePdfPageToHtml(inputData, pageNumber, Number.isInteger(totalPages) ? totalPages : null, textHint || '');
    res.json(parsed);
  } catch (err) {
    console.error('POST /texts/:id/pdf-parse-page error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/texts/:id/pdf-cleanup', pdfVisionLimiter, async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
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
