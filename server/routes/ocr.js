// ---------------------------------------------------------------------------
// OCR routes  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { join } from 'path';
import { readFile } from 'fs/promises';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth.js';
import {
  getTextById,
  getProjectById,
  getPagesByText,
  getTextSettings,
  savePageOCR,
  setTextStatus,
  setTextSummary,
} from '../db.js';
import { getTextDir } from '../services/storage.js';
import { ocrPage, generateSummary } from '../services/bedrock.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read an image from disk, resize to max 2048px, and return base64 JPEG.
 */
async function prepareImage(filePath) {
  const buffer = await readFile(filePath);

  const resized = await sharp(buffer)
    .rotate() // auto-rotate based on EXIF
    .resize({
      width: 2048,
      height: 2048,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90 })
    .toBuffer();

  return resized.toString('base64');
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
// Routes
// ---------------------------------------------------------------------------

// ---- GET /texts/:id/ocr — SSE stream for OCR processing -----------------
router.get('/texts/:id/ocr', async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { text, project } = result;

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Helper to send SSE events
    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Handle client disconnect
    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });

    // Load pages and settings
    const pages = getPagesByText(text.id).filter((p) => p.filename !== '__compiled__');
    const settings = getTextSettings(text.id) || {};
    const dir = getTextDir(req.user.id, project.id, text.id);

    if (pages.length === 0) {
      sendEvent('error', { message: 'No pages found. Upload images first.' });
      res.end();
      return;
    }

    // Mark text as processing
    setTextStatus(text.id, 'processing');
    sendEvent('start', { total: pages.length });

    let processed = 0;
    let errors = 0;

    for (const page of pages) {
      if (aborted) break;

      try {
        const filePath = join(dir, page.filename);
        const base64 = await prepareImage(filePath);
        const ocrText = await ocrPage(base64, settings);

        savePageOCR(text.id, page.filename, ocrText);
        processed++;

        sendEvent('progress', {
          page: processed,
          total: pages.length,
          filename: page.filename,
          preview: ocrText.substring(0, 200),
        });
      } catch (pageErr) {
        errors++;
        console.error(`OCR error for ${page.filename}:`, pageErr.message);

        sendEvent('page-error', {
          filename: page.filename,
          error: pageErr.message,
        });
      }
    }

    if (!aborted) {
      // Mark text as OCR'd
      setTextStatus(text.id, 'ocrd');

      // Compile full text
      const fullText = compileFullText(text.id);

      sendEvent('complete', {
        processed,
        errors,
        total: pages.length,
      });

      // Generate summary in background (non-blocking)
      if (fullText.length > 0) {
        generateSummary(fullText, text.source_language || 'en')
          .then((summary) => {
            setTextSummary(text.id, summary);
          })
          .catch((err) => {
            console.error('Background summary generation failed:', err.message);
          });
      }
    }

    res.end();
  } catch (err) {
    console.error('GET /texts/:id/ocr error:', err);
    // If headers not sent yet, send JSON error; otherwise just end
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error.' });
    } else {
      res.end();
    }
  }
});

// ---- POST /texts/:id/ocr-single — re-OCR a single page ------------------
router.post('/texts/:id/ocr-single', async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { text, project } = result;
    const { filename } = req.body || {};

    if (!filename) {
      return res.status(400).json({ error: 'Filename is required.' });
    }

    // Verify the page exists
    const pages = getPagesByText(text.id);
    const page = pages.find((p) => p.filename === filename);
    if (!page) {
      return res.status(404).json({ error: 'Page not found.' });
    }

    const dir = getTextDir(req.user.id, project.id, text.id);
    const filePath = join(dir, page.filename);
    const settings = getTextSettings(text.id) || {};

    const base64 = await prepareImage(filePath);
    const ocrText = await ocrPage(base64, settings);

    savePageOCR(text.id, page.filename, ocrText);

    res.json({
      filename: page.filename,
      ocr_text: ocrText,
    });
  } catch (err) {
    console.error('POST /texts/:id/ocr-single error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
