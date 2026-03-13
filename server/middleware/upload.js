// ---------------------------------------------------------------------------
// Multer upload middleware — stores images in data/{userId}/{projectId}/{textId}/
// ---------------------------------------------------------------------------

import multer from 'multer';
import { extname } from 'path';
import { mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { sanitizeFilename } from './security.js';
import { getTextDir } from '../services/storage.js';

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.bmp', '.webp']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_PDF_FILE_SIZE = 50 * 1024 * 1024; // bounded by project quota in practice

// [HIGH-1] Magic byte signatures for image validation
const MAGIC_BYTES = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png:  [0x89, 0x50, 0x4E, 0x47],
  tiff_le: [0x49, 0x49, 0x2A, 0x00],
  tiff_be: [0x4D, 0x4D, 0x00, 0x2A],
  bmp:  [0x42, 0x4D],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF header (WebP starts with RIFF....WEBP)
};

/**
 * Validate that a file on disk is actually an image by checking magic bytes.
 */
export function validateImageMagicBytes(filePath) {
  try {
    const buf = readFileSync(filePath, { length: 12 });
    if (buf.length < 2) return false;

    const bytes = [...buf.subarray(0, 12)];

    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true;
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
    // TIFF LE: 49 49 2A 00
    if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00) return true;
    // TIFF BE: 4D 4D 00 2A
    if (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A) return true;
    // BMP: 42 4D
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return true;
    // WebP: RIFF....WEBP
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && buf.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;

    return false;
  } catch {
    return false;
  }
}

export function validatePdfMagicBytes(filePath) {
  try {
    const buf = readFileSync(filePath, { length: 5 });
    if (buf.length < 5) return false;
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2D;
  } catch {
    return false;
  }
}

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

export function createPdfUpload(userId, projectId, textId) {
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
    if (ext === '.pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed.'));
    }
  };

  return multer({
    storage,
    fileFilter,
    limits: {
      fileSize: MAX_PDF_FILE_SIZE,
      files: 1,
      fieldSize: 10 * 1024 * 1024,
    },
  });
}
