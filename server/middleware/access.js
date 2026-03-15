// ---------------------------------------------------------------------------
// Centralized role-aware access verification
// ---------------------------------------------------------------------------

import { getProjectById, getTextById, getUserProjectRole } from '../db.js';

const ROLE_HIERARCHY = { owner: 3, editor: 2, viewer: 1 };

function roleLevel(role) {
  return ROLE_HIERARCHY[role] || 0;
}

/**
 * Verify that `userId` has at least `minRole` access to a project.
 * Returns { project, role } on success or { status, error } on failure.
 */
export function verifyProjectAccess(projectId, userId, minRole = 'viewer') {
  const project = getProjectById(projectId);
  if (!project) {
    return { status: 404, error: 'Project not found.' };
  }

  const role = getUserProjectRole(projectId, userId);
  if (!role || roleLevel(role) < roleLevel(minRole)) {
    return { status: 403, error: 'Access denied.' };
  }

  return { project, role };
}

/**
 * Verify that `userId` has at least `minRole` access to a text (via its project).
 * Returns { text, project, role } on success or { status, error } on failure.
 */
export function verifyTextAccess(textId, userId, minRole = 'viewer') {
  const text = getTextById(textId);
  if (!text) {
    return { status: 404, error: 'Text not found.' };
  }

  const result = verifyProjectAccess(text.project_id, userId, minRole);
  if (result.error) return result;

  return { text, project: result.project, role: result.role };
}
