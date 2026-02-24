// ---------------------------------------------------------------------------
// Cleanup cron — purge expired projects every 24 hours
// ---------------------------------------------------------------------------

import { getExpiredProjects, deleteProject } from '../db.js';
import { deleteProjectFiles } from './storage.js';

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete all expired projects (those past their `expires_at` date).
 */
async function runCleanup() {
  try {
    const expired = getExpiredProjects();

    if (expired.length === 0) return;

    console.log(`[cleanup] Found ${expired.length} expired project(s). Purging...`);

    for (const project of expired) {
      try {
        await deleteProjectFiles(project.user_id, project.id);
        deleteProject(project.id);
        console.log(
          `[cleanup] Cleaned up expired project ID ${project.id} (user ${project.user_id})`
        );
      } catch (err) {
        console.error(
          `[cleanup] Failed to clean up project ${project.id}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error('[cleanup] Cleanup run failed:', err.message);
  }
}

/**
 * Start the cleanup cron job.
 * Runs once immediately on startup, then every 24 hours.
 */
export function startCleanupCron() {
  // Run once on startup (non-blocking)
  runCleanup();

  // Then schedule periodic runs
  setInterval(runCleanup, INTERVAL_MS);

  console.log('[cleanup] Cleanup cron started (every 24 h).');
}
