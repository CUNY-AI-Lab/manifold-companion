// ---------------------------------------------------------------------------
// Storage quota management
// ---------------------------------------------------------------------------

import { join } from 'path';
import { readdir, stat, rm, mkdir } from 'fs/promises';
import { updateUserStorage } from '../db.js';

const MAX_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB per user

export { MAX_STORAGE_BYTES };

/**
 * Root data directory (project-level `data/`).
 */
export function getDataDir() {
  return join(process.cwd(), 'data');
}

/**
 * Per-user directory: `data/{userId}/`
 */
export function getUserDir(userId) {
  return join(getDataDir(), String(userId));
}

/**
 * Per-text directory: `data/{userId}/{projectId}/{textId}/`
 */
export function getTextDir(userId, projectId, textId) {
  return join(getUserDir(userId), String(projectId), String(textId));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively calculate the total byte size of all files under `dir`.
 */
async function dirSize(dir) {
  let total = 0;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory does not exist yet — size is zero
    return 0;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else {
      try {
        const info = await stat(full);
        total += info.size;
      } catch {
        // Ignore files we cannot stat
      }
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate total storage used by a user (bytes).
 */
export async function calculateUserStorage(userId) {
  return dirSize(getUserDir(userId));
}

/**
 * Return true if the user has room for `additionalBytes` more data.
 */
export async function checkQuota(userId, additionalBytes) {
  const current = await calculateUserStorage(userId);
  return (current + additionalBytes) <= MAX_STORAGE_BYTES;
}

/**
 * Recompute disk usage and persist the value to the database.
 */
export async function refreshUserStorage(userId) {
  const bytes = await calculateUserStorage(userId);
  updateUserStorage(userId, bytes);
  return bytes;
}

/**
 * Remove all files for a single text and refresh storage counter.
 */
export async function deleteTextFiles(userId, projectId, textId) {
  const dir = getTextDir(userId, projectId, textId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist — ignore
  }
  await refreshUserStorage(userId);
}

/**
 * Remove all files for a project and refresh storage counter.
 */
export async function deleteProjectFiles(userId, projectId) {
  const dir = join(getUserDir(userId), String(projectId));
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist — ignore
  }
  await refreshUserStorage(userId);
}
