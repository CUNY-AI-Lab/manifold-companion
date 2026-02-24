// ---------------------------------------------------------------------------
// Export routes  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { createReadStream } from 'fs';
import archiver from 'archiver';
import { requireAuth } from '../middleware/auth.js';
import {
  getProjectById,
  getTextById,
  getPagesByText,
  getTextMetadata,
} from '../db.js';
import { getTextDir } from '../services/storage.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Ownership helper
// ---------------------------------------------------------------------------

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
// Routes
// ---------------------------------------------------------------------------

// ---- POST /projects/:projectId/export — generate Manifold ZIP ------------
router.post('/projects/:projectId/export', async (req, res) => {
  try {
    const result = verifyProjectOwnership(
      Number(req.params.projectId),
      req.user.id
    );
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { project } = result;
    const { meta, textIds } = req.body || {};

    if (!textIds || !Array.isArray(textIds) || textIds.length === 0) {
      return res.status(400).json({ error: 'At least one text must be selected for export.' });
    }

    // Validate all texts belong to this project
    const textsToExport = [];
    for (const tid of textIds) {
      const text = getTextById(Number(tid));
      if (!text) {
        return res.status(404).json({ error: `Text ${tid} not found.` });
      }
      if (text.project_id !== project.id) {
        return res.status(400).json({ error: `Text ${tid} does not belong to this project.` });
      }
      textsToExport.push(text);
    }

    // Build metadata object with defaults
    const metadata = {
      title: meta?.title || project.name,
      creators: meta?.creators || '',
      date: meta?.date || new Date().toISOString().split('T')[0],
      language: meta?.language || project.default_language || 'en',
      rights: meta?.rights || '',
      description: meta?.description || project.description || '',
    };

    // Set response headers for ZIP download
    const zipName = `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipName}"`);

    // Create ZIP archive
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive.' });
      }
    });

    // Pipe archive to response
    archive.pipe(res);

    // Build table of contents for manifest
    const toc = [];

    for (let i = 0; i < textsToExport.length; i++) {
      const text = textsToExport[i];
      const textMeta = getTextMetadata(text.id);
      const pages = getPagesByText(text.id);

      // Compile OCR text
      const compiledText = pages
        .filter((p) => p.ocr_text && p.filename !== '__compiled__')
        .map((p) => p.ocr_text)
        .join('\n\n---\n\n');

      // Create markdown file with YAML frontmatter
      const textTitle = textMeta?.dc_title || text.name;
      const textLang = textMeta?.dc_language || metadata.language;
      const textCreator = textMeta?.dc_creator || metadata.creators;

      const mdContent = [
        '---',
        `title: "${escapeYaml(textTitle)}"`,
        `language: "${escapeYaml(textLang)}"`,
        `creator: "${escapeYaml(textCreator)}"`,
        '---',
        '',
        compiledText,
      ].join('\n');

      const mdFilename = `text-${String(i + 1).padStart(2, '0')}-${slugify(text.name)}.md`;
      archive.append(mdContent, { name: mdFilename });

      // Add images from the text's directory
      const dir = getTextDir(req.user.id, project.id, text.id);
      let imageFiles = [];
      try {
        imageFiles = await readdir(dir);
      } catch {
        // Directory may not exist
      }

      const imageDir = `images/${slugify(text.name)}/`;
      for (const imgFile of imageFiles) {
        const imgPath = join(dir, imgFile);
        archive.append(createReadStream(imgPath), { name: imageDir + imgFile });
      }

      toc.push({
        title: textTitle,
        filename: mdFilename,
        images: imageFiles.length,
      });
    }

    // Build manifest.yml
    const manifest = [
      '# Manifold Companion Export',
      `title: "${escapeYaml(metadata.title)}"`,
      `creators: "${escapeYaml(metadata.creators)}"`,
      `date: "${escapeYaml(metadata.date)}"`,
      `language: "${escapeYaml(metadata.language)}"`,
      `rights: "${escapeYaml(metadata.rights)}"`,
      `description: "${escapeYaml(metadata.description)}"`,
      '',
      'toc:',
      ...toc.map(
        (entry) =>
          `  - title: "${escapeYaml(entry.title)}"\n    filename: "${entry.filename}"\n    images: ${entry.images}`
      ),
    ].join('\n');

    archive.append(manifest, { name: 'manifest.yml' });

    // Finalize
    await archive.finalize();
  } catch (err) {
    console.error('POST /projects/:projectId/export error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use inside YAML double-quoted values.
 */
function escapeYaml(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Create a URL/filename-safe slug from a string.
 */
function slugify(str) {
  if (!str) return 'untitled';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60) || 'untitled';
}

export default router;
