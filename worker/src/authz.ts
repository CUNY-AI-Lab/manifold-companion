import { E } from "./errors";
import { isUuid } from "./util";

export type Role = "viewer" | "editor" | "owner";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface ProjectRow {
  id: string;
  owner_subject: string;
  name: string;
  description: string | null;
  project_type: "image_to_markdown" | "pdf_to_html";
  default_language: string;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
  retention_warned_at: string | null;
}

export interface Access {
  project: ProjectRow;
  role: Role;
}

/**
 * THE authorization check. Every project-scoped route calls this exactly once,
 * with the least role it needs, before touching project data. Authentication
 * alone grants nothing.
 *
 *   - not a member (or no such project, or malformed id): 404, so the existence
 *     of other people's projects is not disclosed;
 *   - a member below `minRole`: 403 insufficient_role.
 */
export async function requireRole(db: D1Database, subject: string, projectId: string, minRole: Role): Promise<Access> {
  if (!isUuid(projectId)) throw E.notFound("Project not found.");
  const row = await db
    .prepare(
      `SELECT p.*, m.role AS member_role
       FROM projects p JOIN project_members m ON m.project_id = p.id
       WHERE p.id = ?1 AND m.subject = ?2`,
    )
    .bind(projectId, subject)
    .first<ProjectRow & { member_role: Role }>();
  if (!row) throw E.notFound("Project not found.");
  const { member_role, ...project } = row;
  if (RANK[member_role] < RANK[minRole]) throw E.forbidden("Your role on this project does not allow that.", "insufficient_role");
  return { project, role: member_role };
}
