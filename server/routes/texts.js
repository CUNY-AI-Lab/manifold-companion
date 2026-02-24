// ---------------------------------------------------------------------------
// Text routes  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { join } from 'path';
import { readFile, readdir } from 'fs/promises';
import sharp from 'sharp';
import { requireAuth } from '../middleware/auth.js';
import { createUpload } from '../middleware/upload.js';
import { sanitizeFilename } from '../middleware/security.js';
import {
  createText,
  getTextById,
  getTextsByProject,
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
} from '../db.js';
import {
  getTextDir,
  checkQuota,
  refreshUserStorage,
  deleteTextFiles,
} from '../services/storage.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Ownership helpers
// ---------------------------------------------------------------------------

/**
 * Load a text and verify the requesting user owns it (through its project).
 * Returns { text, project } or throws an object with { status, error }.
 */
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
    res.json({ ...result.text, pages });
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

    const { name, summary, translation } = req.body || {};

    const fields = {};
    if (name !== undefined) fields.name = name.trim();
    if (summary !== undefined) fields.summary = summary;
    if (translation !== undefined) fields.translation = translation;

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
router.post('/texts/:id/upload', async (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    // Check storage quota (rough estimate using content-length header)
    const incomingBytes = Number(req.headers['content-length']) || 0;
    const withinQuota = await checkQuota(req.user.id, incomingBytes);
    if (!withinQuota) {
      return res.status(413).json({ error: 'Storage quota exceeded (50 MB limit).' });
    }

    // Build multer middleware for this text
    const upload = createUpload(req.user.id, result.project.id, result.text.id);
    const mw = upload.array('images', 200);

    mw(req, res, async (uploadErr) => {
      if (uploadErr) {
        console.error('Upload error:', uploadErr);
        return res.status(400).json({ error: uploadErr.message });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded.' });
      }

      // Create page records for each uploaded file
      const pages = [];
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        savePageOCR(result.text.id, file.filename, null);
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

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

// ---- GET /texts/:id/pages — list pages with OCR status -------------------
router.get('/texts/:id/pages', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

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

    const { text: ocrText } = req.body || {};
    if (ocrText === undefined) {
      return res.status(400).json({ error: 'Text content is required.' });
    }

    // Find the page by ID in this text's pages
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

// ---------------------------------------------------------------------------
// Compiled result
// ---------------------------------------------------------------------------

// ---- GET /texts/:id/result — compile full text from all pages ------------
router.get('/texts/:id/result', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const pages = getPagesByText(result.text.id);

    // Compile markdown: join page texts with separator
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

// ---- POST /texts/:id/save — save edited full markdown --------------------
router.post('/texts/:id/save', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { text: compiledText } = req.body || {};
    if (compiledText === undefined) {
      return res.status(400).json({ error: 'Text content is required.' });
    }

    // Store the compiled text as a single page entry with a special filename
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

// ---- GET /texts/:id/metadata ---------------------------------------------
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

// ---- POST /texts/:id/metadata --------------------------------------------
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

// ---- GET /texts/:id/settings ---------------------------------------------
router.get('/texts/:id/settings', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const settings = getTextSettings(result.text.id);
    res.json(settings || {});
  } catch (err) {
    console.error('GET /texts/:id/settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/settings --------------------------------------------
router.post('/texts/:id/settings', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

    saveTextSettings(result.text.id, req.body || {});

    const settings = getTextSettings(result.text.id);
    res.json(settings || {});
  } catch (err) {
    console.error('POST /texts/:id/settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /texts/:id/settings — reset to defaults ----------------------
router.delete('/texts/:id/settings', (req, res) => {
  try {
    const result = verifyTextOwnership(Number(req.params.id), req.user.id);
    if (result.error) return res.status(result.status).json({ error: result.error });

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

// ---- GET /texts/:id/image/:filename — serve image file -------------------
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

    // Read the original file
    let buffer;
    try {
      buffer = await readFile(filePath);
    } catch {
      return res.status(404).json({ error: 'Image not found.' });
    }

    // Use Sharp for smart rotation and optional resizing
    let pipeline = sharp(buffer).rotate(); // .rotate() auto-rotates based on EXIF

    // Check orientation — if landscape and no EXIF rotation, rotate to portrait
    const metadata = await sharp(buffer).metadata();
    if (metadata.width > metadata.height && !metadata.orientation) {
      pipeline = sharp(buffer).rotate(90);
    } else {
      pipeline = sharp(buffer).rotate();
    }

    // Support ?w= query param for thumbnail width
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

export default router;
