import { Hono } from "hono";
import { readJsonObject, optionalString } from "../body";
import { BASE_PATH, canonicalOrigin, limits } from "../env";
import { E } from "../errors";
import { deleteProfileData } from "../storage";
import { nowIso } from "../util";
import type { AppEnv } from "../app";

export const sessionRoutes = new Hono<AppEnv>();

interface ProfileRow {
  subject: string;
  display_name: string | null;
  theme_preference: "system" | "light" | "dark";
  onboarded: number;
  storage_bytes: number;
  created_at: string;
  last_seen_at: string;
}

async function loadProfile(db: D1Database, subject: string): Promise<ProfileRow> {
  const row = await db.prepare("SELECT * FROM profiles WHERE subject = ?1").bind(subject).first<ProfileRow>();
  if (!row) throw E.notFound("Profile not found.");
  return row;
}

function profileBody(p: ProfileRow) {
  return { display_name: p.display_name, theme_preference: p.theme_preference, onboarded: p.onboarded === 1 };
}

// The frontend's session probe: a 200 means signed in. The profile is keyed on
// the opaque subject; there is no email, name or password anywhere in it.
sessionRoutes.get("/session", async (c) => {
  const { subject } = c.get("principal");
  const lim = limits(c.env);
  const hourAgo = nowIso(Date.now() - 3_600_000);
  // Throttled: at most one write an hour per person.
  await c.env.DB.prepare("UPDATE profiles SET last_seen_at = ?1 WHERE subject = ?2 AND last_seen_at < ?3").bind(nowIso(), subject, hourAgo).run();
  const profile = await loadProfile(c.env.DB, subject);
  return c.json({
    subject,
    profile: profileBody(profile),
    storage: { used_bytes: profile.storage_bytes, quota_bytes: lim.storageQuotaBytes },
    limits: { max_file_bytes: lim.maxFileBytes, max_project_pages: lim.maxProjectPages, max_projects: lim.maxProjectsPerPerson },
    retention: { days: lim.retentionDays, warn_days: lim.retentionWarnDays },
    base_path: BASE_PATH,
    origin: canonicalOrigin(c.env),
  });
});

sessionRoutes.put("/profile", async (c) => {
  const { subject } = c.get("principal");
  const body = await readJsonObject(c.req.raw, limits(c.env).maxJsonBytes);
  const sets: string[] = [];
  const values: unknown[] = [];
  const name = body.display_name;
  if (name !== undefined) {
    if (name !== null && typeof name !== "string") throw E.badRequest("display_name must be a string or null.");
    const trimmed = name === null ? null : name.trim();
    if (trimmed !== null && trimmed.length > 80) throw E.badRequest("display_name must be at most 80 characters.");
    // eslint-disable-next-line no-control-regex
    if (trimmed !== null && /[\u0000-\u001f\u007f<>]/.test(trimmed)) throw E.badRequest("display_name contains characters that are not allowed.");
    sets.push("display_name = ?");
    values.push(trimmed === "" ? null : trimmed);
  }
  const theme = optionalString(body, "theme_preference", 10);
  if (theme !== undefined) {
    if (theme !== "system" && theme !== "light" && theme !== "dark") throw E.badRequest("theme_preference must be system, light or dark.");
    sets.push("theme_preference = ?");
    values.push(theme);
  }
  if (body.onboarded !== undefined) {
    if (typeof body.onboarded !== "boolean") throw E.badRequest("onboarded must be a boolean.");
    sets.push("onboarded = ?");
    values.push(body.onboarded ? 1 : 0);
  }
  if (sets.length === 0) throw E.badRequest("Nothing to update.");
  await c.env.DB.prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE subject = ?`).bind(...values, subject).run();
  return c.json({ profile: profileBody(await loadProfile(c.env.DB, subject)) });
});

// "Delete my data": owned projects (with their stored objects), then the profile.
sessionRoutes.delete("/me/data", async (c) => {
  const { subject } = c.get("principal");
  const body = await readJsonObject(c.req.raw, 1024);
  if (body.confirm !== "delete my data") throw E.badRequest('Send {"confirm":"delete my data"} to confirm.', "confirmation_required");
  const result = await deleteProfileData(c.env, subject);
  return c.json({ deleted: true, projects_deleted: result.projects });
});
