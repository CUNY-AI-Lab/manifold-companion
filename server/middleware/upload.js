// ---------------------------------------------------------------------------
// Multer upload middleware — stores images in data/{userId}/{projectId}/{textId}/
// ---------------------------------------------------------------------------

import multer from 'multer';
import { extname } from 'path';
import { mkdir } from 'fs/promises';
import { sanitizeFilename } from './security.js';
import { getTextDir } from '../services/storage.js';

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.bmp', '.webp']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file

/**
 * Create a configured multer middleware for uploading images into a text's
 * directory on disk.
 *
 * @param {number} userId
 * @param {number} projectId
 * @param {number} textId
 * @returns multer middleware (handles `req.files`)
 */
export function createUpload(userId, projectId, textId) {
  const dest = getTextDir(userId, projectId, textId);

  const storage = multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await mkdir(dest, { recursive: true });
        cb(null, dest);
      } catch (err) {
        cb(err);
      }
    },

    filename: (_req, file, cb) => {
      const safe = sanitizeFilename(file.originalname);
      if (!safe) {
        return cb(new Error('Invalid filename.'));
      }
      cb(null, safe);
    },
  });

  const fileFilter = (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} is not allowed. Accepted: ${[...ALLOWED_EXTENSIONS].join(', ')}`));
    }
  };

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 200, // reasonable upper bound per upload batch
    },
  });
}
