// ---------------------------------------------------------------------------
// Export routes  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import archiver from 'archiver';
import { requireAuth } from '../middleware/auth.js';
import {
  getProjectById,
  getTextById,
  getPagesByText,
  getTextMetadata,
  getProjectExportSettings,
  saveProjectExportSettings,
} from '../db.js';

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

// ---- GET /projects/:projectId/export-settings — load saved export config --
router.get('/projects/:projectId/export-settings', (req, res) => {
  try {
    const result = verifyProjectOwnership(
      Number(req.params.projectId),
      req.user.id
    );
    if (result.error) return res.status(result.status).json({ error: result.error });

    const settings = getProjectExportSettings(result.project.id);
    res.json({ settings });
  } catch (err) {
    console.error('GET /projects/:projectId/export-settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /projects/:projectId/export — generate Manifold ZIP ------------
router.post('/projects/:projectId/export', async (req, res) => {
  try {
    const result = verifyProjectOwnership(
      Number(req.params.projectId),
      req.user.id
    );
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { project } = result;
    const { meta, toc: tocTree, tocFlat, textIds } = req.body || {};

    // Backward compatibility: if flat textIds provided (old format), convert to toc tree
    let resolvedToc;
    if (tocTree && Array.isArray(tocTree) && tocTree.length > 0) {
      resolvedToc = tocTree;
    } else if (textIds && Array.isArray(textIds) && textIds.length > 0) {
      resolvedToc = textIds.map((tid) => {
        const text = getTextById(Number(tid));
        return { type: 'text', label: text?.name || 'Untitled', textId: Number(tid), children: [] };
      });
    } else {
      return res.status(400).json({ error: 'At least one item must be included for export.' });
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

    // Validate all text nodes belong to this project
    function validateTree(nodes, depth = 0) {
      if (depth > 10) return 'Table of contents nesting is too deep (max 10 levels).';
      for (const node of nodes) {
        if (node.type === 'text' && node.textId != null) {
          const text = getTextById(Number(node.textId));
          if (!text) return `Text ${node.textId} not found.`;
          if (text.project_id !== project.id) return `Text ${node.textId} does not belong to this project.`;
        }
        if (node.children?.length) {
          const err = validateTree(node.children, depth + 1);
          if (err) return err;
        }
      }
      return null;
    }
    const validationError = validateTree(resolvedToc);
    if (validationError) return res.status(400).json({ error: validationError });

    // Set response headers for ZIP download
    const safeAscii = `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;
    const encoded = encodeURIComponent(project.name + '.zip');
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`);

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

    // Counter for unique filenames
    let fileCounter = 0;

    // Recursive tree walker — processes each node, adds files to archive, returns toc entries
    function processNode(node) {
      fileCounter++;
      const num = String(fileCounter).padStart(2, '0');

      if (node.type === 'section') {
        // Section: create a section markdown with just a heading
        const mdFilename = `section-${num}-${slugify(node.label)}.md`;
        const mdContent = [
          '---',
          `title: "${escapeYaml(node.label)}"`,
          '---',
          '',
          `# ${node.label}`,
        ].join('\n');
        archive.append(mdContent, { name: mdFilename });

        const entry = {
          label: node.label,
          source_path: mdFilename,
          start_section: true,
        };
        if (node.children?.length) {
          entry.children = node.children.map(processNode);
        }
        return entry;
      }

      // Text node
      const text = getTextById(Number(node.textId));
      const textMeta = text ? getTextMetadata(text.id) : null;
      const pages = text ? getPagesByText(text.id) : [];

      const compiledText = pages
        .filter((p) => p.ocr_text && p.filename !== '__compiled__')
        .map((p) => p.ocr_text)
        .join('\n\n---\n\n');

      const textTitle = textMeta?.dc_title || node.label || text?.name || 'Untitled';
      const textLang = textMeta?.dc_language || metadata.language;
      const textCreator = textMeta?.dc_creator || metadata.creators;

      const mdFilename = `text-${num}-${slugify(node.label || text?.name)}.md`;
      const mdContent = [
        '---',
        `title: "${escapeYaml(textTitle)}"`,
        `language: "${escapeYaml(textLang)}"`,
        `creator: "${escapeYaml(textCreator)}"`,
        '---',
        '',
        compiledText,
      ].join('\n');
      archive.append(mdContent, { name: mdFilename });

      const entry = {
        label: textTitle,
        source_path: mdFilename,
      };
      if (node.children?.length) {
        entry.children = node.children.map(processNode);
      }
      return entry;
    }

    // Process all top-level nodes
    const manifestToc = resolvedToc.map(processNode);

    // Build manifest.yml with recursive toc
    const manifestLines = [
      '# Manifold Companion Export',
      '',
      'meta:',
      `  title: "${escapeYaml(metadata.title)}"`,
      `  creators:`,
      ...metadata.creators.split(/\s*[,;]\s*/).filter(Boolean).map((c) => `    - "${escapeYaml(c.trim())}"`),
      `  date: "${escapeYaml(metadata.date)}"`,
      `  language: "${escapeYaml(metadata.language)}"`,
      `  rights: "${escapeYaml(metadata.rights)}"`,
      `  description: "${escapeYaml(metadata.description)}"`,
      '',
      'toc:',
      ...manifestToc.flatMap((entry) => tocEntryYaml(entry, 2)),
    ];

    archive.append(manifestLines.join('\n'), { name: 'manifest.yml' });

    // Finalize
    await archive.finalize();

    // Persist export settings for next time
    if (tocFlat || meta) {
      try {
        saveProjectExportSettings(project.id, { tocFlat: tocFlat || [], meta: meta || {} });
      } catch (_) { /* non-critical */ }
    }
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

/**
 * Recursively build YAML lines for a toc entry with proper indentation.
 */
function tocEntryYaml(entry, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  lines.push(`${pad}- label: "${escapeYaml(entry.label)}"`);
  lines.push(`${pad}  source_path: "${entry.source_path}"`);
  if (entry.start_section) {
    lines.push(`${pad}  start_section: true`);
  }
  if (entry.children?.length) {
    lines.push(`${pad}  children:`);
    for (const child of entry.children) {
      lines.push(...tocEntryYaml(child, indent + 4));
    }
  }
  return lines;
}

export default router;
