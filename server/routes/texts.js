// ---------------------------------------------------------------------------
// Text routes  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { join } from 'path';
import { readFile, unlink } from 'fs/promises';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimits.js';
import { createUpload, createPdfUpload, validateImageMagicBytes, validatePdfMagicBytes } from '../middleware/upload.js';
import { sanitizeFilename } from '../middleware/security.js';
import {
  createText,
  getTextById,
  updateText,
  deleteText,
  getProjectById,
  getPagesByText,
  savePageText,
  getTextMetadata,
  saveTextMetadata,
  getTextSettings,
  saveTextSettings,
  deleteTextSettings,
  savePageOCR,
  deletePage,
  reorderPages,
  getMaxPageNumber,
  getTextHtml,
  saveTextHtml,
} from '../db.js';
import {
  getTextDir,
  calculateUserStorage,
  refreshUserStorage,
  deleteTextFiles,
  MAX_STORAGE_BYTES,
  MAX_ADMIN_STORAGE_BYTES,
} from '../services/storage.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// [HIGH-6] Allowed model IDs for OCR settings validation
const ALLOWED_MODELS = new Set([
  'qwen.qwen3-vl-235b-a22b',
  'openai.gpt-oss-120b-1:0',
  'us.amazon.nova-pro-v1:0',
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'anthropic.claude-sonnet-4-20250514-v1:0',
]);

// [MED-6] Allowed language codes for translation
const ALLOWED_LANGUAGES = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko', 'ar', 'hi',
  'nl', 'sv', 'da', 'no', 'fi', 'pl', 'cs', 'el', 'tr', 'he', 'th', 'vi',
  'uk', 'ro', 'hu', 'id', 'ms', 'ca', 'hr', 'sk', 'bg', 'sr', 'lt', 'lv',
  'et', 'sl', 'ga', 'sq', 'mk', 'bs', 'mt', 'is', 'cy', 'la', 'auto-detect',
]);

// ---------------------------------------------------------------------------
// Ownership helpers
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

function verifyProjectOwnership(projectId, userId) {
  const project = getProjectById(projectId);
  if (!project) {
    return { status: 404, error: 'Project not found.' };
  }
  if (project.user_id !== userId) {
    return { status: 403, error: 'Access denied.' };
  }
  return { project };
}

function requireProjectType(project, expectedType) {
  if (project.project_type !== expectedType) {
    return { status: 400, error: `This action is only available for ${expectedType} projects.` };
  }
  return {};
}

function requireImageProject(project) {
  return requireProjectType(project, 'image_to_markdown');
}

function requirePdfProject(project) {
  return requireProjectType(project, 'pdf_to_html');
}

// ---------------------------------------------------------------------------
// Text CRUD
// ---------------------------------------------------------------------------

// ---- POST /projects/:projectId/texts — create text -----------------------
router.post('/projects/:projectId/texts', (req, res) => {
  try {
    const { project, status, error } = verifyProjectOwnership(
      Number(req.params.projectId),
      req.user.id
    );
    if (error) return res.status(status).json({ error });

    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Text name is required.' });
    }

    const textId = createText(project.id, name.trim());
    const text = getTextById(textId);
    res.status(201).json(text);
  } catch (err) {
    console.error('POST /projects/:projectId/texts error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /texts/:id — get text detail ------------------------------------
router.get('/texts/:id', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const pages = getPagesByText(result.text.id);
    res.json({ ...result.text, pages, project_type: result.project.project_type });
  } catch (err) {
    console.error('GET /texts/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /texts/:id — update text fields ---------------------------------
router.put('/texts/:id', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { name, summary, translation, source_language, target_language } = req.body || {};

    const fields = {};
    if (name !== undefined) fields.name = name.trim();
    if (summary !== undefined) fields.summary = summary;
    if (translation !== undefined) fields.translation = translation;
    // [MED-6] Validate language codes
    if (source_language !== undefined) {
      if (source_language && !ALLOWED_LANGUAGES.has(source_language)) {
        return res.status(400).json({ error: 'Invalid source language code.' });
      }
      fields.source_language = source_language;
    }
    if (target_language !== undefined) {
      if (target_language && !ALLOWED_LANGUAGES.has(target_language)) {
        return res.status(400).json({ error: 'Invalid target language code.' });
      }
      fields.target_language = target_language;
    }

    updateText(result.text.id, fields);
    const updated = getTextById(result.text.id);
    res.json(updated);
  } catch (err) {
    console.error('PUT /texts/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /texts/:id — delete text + files ------------------------------
router.delete('/texts/:id', async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    await deleteTextFiles(req.user.id, result.project.id, result.text.id);
    deleteText(result.text.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /texts/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

// ---- POST /texts/:id/upload — upload images to text ----------------------
router.post('/texts/:id/upload', uploadLimiter, async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requireImageProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    // [HIGH-4] Check storage quota using real disk measurement, not Content-Length header
    const quota = req.user.role === 'admin' ? MAX_ADMIN_STORAGE_BYTES : MAX_STORAGE_BYTES;
    const currentUsage = await calculateUserStorage(req.user.id);
    if (currentUsage >= quota) {
      const limitLabel = req.user.role === 'admin' ? '500 MB' : '50 MB';
      return res.status(413).json({ error: `Storage quota exceeded (${limitLabel} limit).` });
    }

    // Build multer middleware for this text
    const upload = createUpload(req.user.id, result.project.id, result.text.id);
    const mw = upload.array('images', 200);

    mw(req, res, async (uploadErr) => {
      if (uploadErr) {
        console.error('Upload error:', uploadErr);
        const safeMsg = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'File too large (10 MB limit per file).'
          : uploadErr.code === 'LIMIT_FILE_COUNT' ? 'Too many files (200 per upload).'
          : uploadErr.code === 'LIMIT_UNEXPECTED_FILE' ? 'Unexpected file field.'
          : 'Upload failed. Please try again.';
        return res.status(400).json({ error: safeMsg });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
      }

      // [HIGH-1] Validate magic bytes and remove invalid files
      const validFiles = [];
      for (const file of req.files) {
        if (validateImageMagicBytes(file.path)) {
          validFiles.push(file);
        } else {
          // Delete the invalid file from disk
          try { await unlink(file.path); } catch { /* ignore */ }
        }
      }

      if (validFiles.length === 0) {
        return res.status(400).json({ error: 'No valid image files found.' });
      }

      // Create page records for each uploaded file, assigning page_number
      const startNum = getMaxPageNumber(result.text.id);
      const pages = [];
      for (let i = 0; i < validFiles.length; i++) {
        const file = validFiles[i];
        savePageOCR(result.text.id, file.filename, null, startNum + i + 1);
        pages.push({ filename: file.filename, size: file.size });
      }

      // Refresh storage after upload
      await refreshUserStorage(req.user.id);

      res.status(201).json({
        uploaded: pages.length,
        files: pages,
      });
    });
  } catch (err) {
    console.error('POST /texts/:id/upload error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/pdf-upload — upload source PDF + generated HTML -----
router.post('/texts/:id/pdf-upload', uploadLimiter, async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requirePdfProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const quota = req.user.role === 'admin' ? MAX_ADMIN_STORAGE_BYTES : MAX_STORAGE_BYTES;
    const currentUsage = await calculateUserStorage(req.user.id);
    if (currentUsage >= quota) {
      const limitLabel = req.user.role === 'admin' ? '500 MB' : '50 MB';
      return res.status(413).json({ error: `Storage quota exceeded (${limitLabel} limit).` });
    }

    const upload = createPdfUpload(req.user.id, result.project.id, result.text.id);
    const mw = upload.single('pdf');

    mw(req, res, async (uploadErr) => {
      if (uploadErr) {
        console.error('PDF upload error:', uploadErr);
        const safeMsg = uploadErr.code === 'LIMIT_FILE_SIZE'
          ? 'PDF file too large.'
          : uploadErr.code === 'LIMIT_FILE_COUNT'
            ? 'Only one PDF can be uploaded at a time.'
            : 'PDF upload failed. Please try again.';
        return res.status(400).json({ error: safeMsg });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No PDF uploaded.' });
      }

      if (!validatePdfMagicBytes(req.file.path)) {
        try { await unlink(req.file.path); } catch { /* ignore */ }
        return res.status(400).json({ error: 'Uploaded file is not a valid PDF.' });
      }

      const htmlContent = typeof req.body.html_content === 'string' ? req.body.html_content : '';
      if (!htmlContent.trim()) {
        try { await unlink(req.file.path); } catch { /* ignore */ }
        return res.status(400).json({ error: 'Generated HTML content is required.' });
      }

      let pdfMeta = null;
      if (req.body.pdf_meta) {
        try {
          pdfMeta = JSON.parse(req.body.pdf_meta);
        } catch {
          try { await unlink(req.file.path); } catch { /* ignore */ }
          return res.status(400).json({ error: 'Invalid PDF metadata payload.' });
        }
      }

      const formulaRepairStatus =
        typeof req.body.formula_repair_status === 'string' && req.body.formula_repair_status.trim()
          ? req.body.formula_repair_status.trim()
          : 'not_needed';

      const existingHtml = getTextHtml(result.text.id);
      if (existingHtml?.source_pdf_name && existingHtml.source_pdf_name !== req.file.filename) {
        try {
          await unlink(join(getTextDir(req.user.id, result.project.id, result.text.id), existingHtml.source_pdf_name));
        } catch {
          // Old PDF may not exist anymore.
        }
      }

      await refreshUserStorage(req.user.id);
      saveTextHtml(result.text.id, htmlContent, {
        sourcePdfName: req.file.filename,
        pdfMeta,
        formulaRepairStatus,
      });
      updateText(result.text.id, { status: 'reviewed' });
      const html = getTextHtml(result.text.id);
      res.status(201).json({
        ok: true,
        source_pdf_name: req.file.filename,
        html_content: html?.html_content || '',
        pdf_meta: html?.pdf_meta || null,
        formula_repair_status: html?.formula_repair_status || formulaRepairStatus,
      });
    });
  } catch (err) {
    console.error('POST /texts/:id/pdf-upload error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

// ---- GET /texts/:id/pages — list pages with OCR status -------------------
router.get('/texts/:id/pages', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requireImageProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const pages = getPagesByText(result.text.id);
    res.json(pages);
  } catch (err) {
    console.error('GET /texts/:id/pages error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/pages/:pageId — update single page OCR text --------
router.post('/texts/:id/pages/:pageId', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requireImageProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const { text: ocrText } = req.body || {};
    if (ocrText === undefined) {
      return res.status(400).json({ error: 'Text content is required.' });
    }

    const pages = getPagesByText(result.text.id);
    const page = pages.find((p) => p.id === Number(req.params.pageId));
    if (!page) {
      return res.status(404).json({ error: 'Page not found.' });
    }

    savePageText(result.text.id, page.filename, ocrText);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /texts/:id/pages/:pageId error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /texts/:id/pages/:pageId — delete a single page ---------------
router.delete('/texts/:id/pages/:pageId', async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const pageId = Number(req.params.pageId);
    const pages = getPagesByText(result.text.id);
    const page = pages.find((p) => p.id === pageId);
    if (!page) {
      return res.status(404).json({ error: 'Page not found.' });
    }

    const dir = getTextDir(req.user.id, result.project.id, result.text.id);
    try {
      await unlink(join(dir, page.filename));
    } catch {
      // File may not exist — ignore
    }

    deletePage(pageId);
    await refreshUserStorage(req.user.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /texts/:id/pages/:pageId error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /texts/:id/pages/reorder — reorder pages -------------------------
router.put('/texts/:id/pages/reorder', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requireImageProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const { pageIds } = req.body || {};
    if (!Array.isArray(pageIds) || pageIds.length === 0) {
      return res.status(400).json({ error: 'pageIds array is required.' });
    }

    // [HIGH-7] Bound pageIds array to prevent DoS via bulk DB writes
    if (pageIds.length > 1000) {
      return res.status(400).json({ error: 'Too many page IDs (max 1000).' });
    }

    reorderPages(result.text.id, pageIds.map(Number));
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /texts/:id/pages/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Compiled result
// ---------------------------------------------------------------------------

router.get('/texts/:id/result', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const pages = getPagesByText(result.text.id);
    const compiled = pages
      .filter((p) => p.ocr_text)
      .map((p) => p.ocr_text)
      .join('\n\n---\n\n');

    res.json({ text: compiled, pageCount: pages.length });
  } catch (err) {
    console.error('GET /texts/:id/result error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/texts/:id/html', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requirePdfProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const html = getTextHtml(result.text.id);
    res.json({
      html_content: html?.html_content || '',
      source_pdf_name: html?.source_pdf_name || null,
      pdf_meta: html?.pdf_meta || null,
      formula_repair_status: html?.formula_repair_status || null,
    });
  } catch (err) {
    console.error('GET /texts/:id/html error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.put('/texts/:id/html', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requirePdfProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const { html_content, pdf_meta, formula_repair_status } = req.body || {};
    if (html_content === undefined) {
      return res.status(400).json({ error: 'HTML content is required.' });
    }

    saveTextHtml(result.text.id, html_content, {
      pdfMeta: pdf_meta,
      formulaRepairStatus: formula_repair_status,
    });

    const html = getTextHtml(result.text.id);
    res.json(html || {});
  } catch (err) {
    console.error('PUT /texts/:id/html error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/texts/:id/save', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { text: compiledText } = req.body || {};
    if (compiledText === undefined) {
      return res.status(400).json({ error: 'Text content is required.' });
    }

    savePageText(result.text.id, '__compiled__', compiledText);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /texts/:id/save error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Metadata (Dublin Core)
// ---------------------------------------------------------------------------

router.get('/texts/:id/metadata', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const metadata = getTextMetadata(result.text.id);
    res.json(metadata || {});
  } catch (err) {
    console.error('GET /texts/:id/metadata error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/texts/:id/metadata', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    saveTextMetadata(result.text.id, req.body || {});

    const metadata = getTextMetadata(result.text.id);
    res.json(metadata || {});
  } catch (err) {
    console.error('POST /texts/:id/metadata error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// OCR Settings
// ---------------------------------------------------------------------------

router.get('/texts/:id/settings', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requireImageProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const settings = getTextSettings(result.text.id);
    res.json(settings || {});
  } catch (err) {
    console.error('GET /texts/:id/settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// [HIGH-6] Validate model, temperature, and max_tokens before saving
router.post('/texts/:id/settings', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requireImageProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const { prompt, model, temperature, max_tokens } = req.body || {};
    const validated = {};

    if (prompt !== undefined) {
      if (typeof prompt === 'string' && prompt.length > 3000) {
        return res.status(400).json({ error: 'Prompt must be 3000 characters or fewer.' });
      }
      validated.prompt = prompt;
    }
    if (model !== undefined) {
      if (model && !ALLOWED_MODELS.has(model)) {
        return res.status(400).json({ error: 'Invalid model ID.' });
      }
      validated.model = model || null;
    }
    if (temperature !== undefined) {
      const temp = Number(temperature);
      if (isNaN(temp) || temp < 0 || temp > 1) {
        return res.status(400).json({ error: 'Temperature must be between 0 and 1.' });
      }
      validated.temperature = temp;
    }
    if (max_tokens !== undefined) {
      const mt = Number(max_tokens);
      if (isNaN(mt) || mt < 1 || mt > 8192) {
        return res.status(400).json({ error: 'max_tokens must be between 1 and 8192.' });
      }
      validated.max_tokens = mt;
    }

    saveTextSettings(result.text.id, validated);

    const settings = getTextSettings(result.text.id);
    res.json(settings || {});
  } catch (err) {
    console.error('POST /texts/:id/settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.delete('/texts/:id/settings', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requireImageProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    deleteTextSettings(result.text.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /texts/:id/settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---------------------------------------------------------------------------
// Image serving
// ---------------------------------------------------------------------------

router.get('/texts/:id/image/:filename', async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const safe = sanitizeFilename(req.params.filename);
    if (!safe) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }

    const dir = getTextDir(req.user.id, result.project.id, result.text.id);
    const filePath = join(dir, safe);

    let buffer;
    try {
      buffer = await readFile(filePath);
    } catch {
      return res.status(404).json({ error: 'Image not found.' });
    }

    let pipeline = sharp(buffer).rotate();

    const metadata = await sharp(buffer).metadata();
    if (metadata.width > metadata.height && !metadata.orientation) {
      pipeline = sharp(buffer).rotate(90);
    } else {
      pipeline = sharp(buffer).rotate();
    }

    const width = parseInt(req.query.w, 10);
    if (width && width > 0 && width <= 4096) {
      pipeline = pipeline.resize({ width, withoutEnlargement: true });
    }

    const output = await pipeline.jpeg({ quality: 85 }).toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(output);
  } catch (err) {
    console.error('GET /texts/:id/image/:filename error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/texts/:id/source-pdf/:filename', async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const typeCheck = requirePdfProject(result.project);
    if (typeCheck.error) return res.status(typeCheck.status).json({ error: typeCheck.error });

    const safe = sanitizeFilename(req.params.filename);
    if (!safe || safe !== result.text.source_pdf_name) {
      return res.status(404).json({ error: 'PDF not found.' });
    }

    const dir = getTextDir(req.user.id, result.project.id, result.text.id);
    const filePath = join(dir, safe);

    let buffer;
    try {
      buffer = await readFile(filePath);
    } catch {
      return res.status(404).json({ error: 'PDF not found.' });
    }

    res.set('Content-Type', 'application/pdf');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    console.error('GET /texts/:id/source-pdf/:filename error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export { ALLOWED_LANGUAGES };
export default router;
