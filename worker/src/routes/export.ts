// Export routes, mounted at /projects/:id. Export is a read (viewer and up, as
// in legacy); saving export settings is a write (editor and up).
import { Hono } from "hono";
import { requireRole } from "../authz";
import { readJsonObject } from "../body";
import { byteLength } from "../content";
import { E } from "../errors";
import { exportFileNames, parseExcluded, parseMeta, parseSavedMeta, parseToc, parseTocFlat, planExport, streamExport } from "../export";
import { nowIso } from "../util";
import type { AppEnv } from "../app";

export const exportRoutes = new Hono<AppEnv>();
const MAX_SETTINGS_BYTES = 64 * 1024;
const RANK = { viewer: 1, editor: 2, owner: 3 } as const;

async function saveSettings(db: D1Database, projectId: string, settings: unknown): Promise<void> {
  const json = JSON.stringify(settings);
  if (byteLength(json) > MAX_SETTINGS_BYTES) throw E.tooLarge(`Export settings can be at most ${MAX_SETTINGS_BYTES} bytes.`);
  await db.prepare(
    "INSERT INTO export_settings (project_id, settings_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(project_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at",
  ).bind(projectId, json, nowIso()).run();
}

exportRoutes.get("/:id/export-settings", async (c) => {
  const { project } = await requireRole(c.env.DB, c.get("principal").subject, c.req.param("id"), "viewer");
  const row = await c.env.DB.prepare("SELECT settings_json FROM export_settings WHERE project_id = ?1").bind(project.id).first<{ settings_json: string }>();
  return c.json({ settings: row ? JSON.parse(row.settings_json) : null });
});

exportRoutes.put("/:id/export-settings", async (c) => {
  const { project } = await requireRole(c.env.DB, c.get("principal").subject, c.req.param("id"), "editor");
  const body = await readJsonObject(c.req.raw, MAX_SETTINGS_BYTES + 1024);
  const settings = { tocFlat: parseTocFlat(body.tocFlat), excluded: parseExcluded(body.excluded), meta: parseSavedMeta(body.meta) };
  await saveSettings(c.env.DB, project.id, settings);
  return c.json({ ok: true, settings });
});

exportRoutes.post("/:id/export", async (c) => {
  const { project, role } = await requireRole(c.env.DB, c.get("principal").subject, c.req.param("id"), "viewer");
  const body = await readJsonObject(c.req.raw, 1024 * 1024);
  const toc = parseToc(body.toc);
  const meta = parseMeta(body.meta, project, nowIso().slice(0, 10));
  const saving = RANK[role] >= RANK.editor && (body.tocFlat !== undefined || body.meta !== undefined);
  const settings = saving ? { tocFlat: parseTocFlat(body.tocFlat), excluded: parseExcluded(body.excluded), meta: parseSavedMeta(body.meta) } : null;
  const plan = await planExport(c.env, project, toc, meta);
  // Legacy saved the export choices for next time on every export, even a viewer's.
  // Here only someone who may edit the project changes its saved settings.
  if (settings) await saveSettings(c.env.DB, project.id, settings);
  const names = exportFileNames(project.name);
  return new Response(streamExport(c.env, plan), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${names.ascii}"; filename*=UTF-8''${names.utf8}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox; default-src 'none'",
      "cross-origin-resource-policy": "same-origin",
    },
  });
});
