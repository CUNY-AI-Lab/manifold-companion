import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { nowIso } from "../src/util";
import snapshot from "./schema.snapshot.json";

interface MasterRow { type: string; name: string; tbl_name: string; sql: string | null }

const norm = (sql: string | null) => (sql ?? "").replace(/\s+/g, " ").trim();

async function dump(db: D1Database): Promise<MasterRow[]> {
  const rows = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' AND name NOT LIKE 'text_fts%' AND name NOT LIKE 'texts_fts_%' ORDER BY type, name")
    .all<MasterRow>();
  return rows.results.map((r) => ({ ...r, sql: norm(r.sql) }));
}

async function describeSchema(db: D1Database) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' AND name NOT LIKE 'text_fts%' ORDER BY name").all<{ name: string }>()).results;
  const out: Record<string, string[]> = {};
  for (const { name } of tables) {
    const cols = (await db.prepare(`SELECT name, type, "notnull", pk FROM pragma_table_info('${name}')`).all<{ name: string; type: string; notnull: number; pk: number }>()).results;
    out[name] = cols.map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PK" : ""}`);
  }
  return out;
}

describe("migrations", () => {
  it("fresh all-at-once schema equals the stepwise-migrated schema", async () => {
    const [first, ...rest] = env.TEST_MIGRATIONS;
    await applyD1Migrations(env.DB_STEPWISE, [first!]);
    const afterFirst = await dump(env.DB_STEPWISE);
    expect(afterFirst.some((r) => r.name === "text_fts")).toBe(false);
    await applyD1Migrations(env.DB_STEPWISE, [first!, ...rest]);
    expect(await dump(env.DB_STEPWISE)).toEqual(await dump(env.DB));
  });

  // FTS5 on remote D1 is unconfirmed, so no migration may depend on it: a refused
  // migration would block the deploy. The index is created at runtime instead.
  it("no migration creates an FTS5 object; the runtime creates them idempotently and backfills", async () => {
    for (const m of env.TEST_MIGRATIONS) expect(m.queries.join("\n").replace(/--[^\n]*/g, ""), m.name).not.toMatch(/fts5|VIRTUAL TABLE/i);
    await applyD1Migrations(env.DB_STEPWISE, env.TEST_MIGRATIONS);
    const { ensureSearchIndex, resetSearchIndexState } = await import("../src/search");
    const t = nowIso();
    await env.DB_STEPWISE.batch([
      env.DB_STEPWISE.prepare("INSERT OR IGNORE INTO profiles (subject) VALUES ('cail-00000000000000000000000000000001')"),
      env.DB_STEPWISE.prepare("INSERT OR IGNORE INTO projects (id, owner_subject, name, created_at, updated_at, last_edited_at) VALUES ('00000000-0000-4000-8000-0000000000aa', 'cail-00000000000000000000000000000001', 'p', ?1, ?1, ?1)").bind(t),
      env.DB_STEPWISE.prepare("INSERT OR IGNORE INTO texts (id, project_id, name, search_text, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-0000000000aa', 'T', 'backfilled words', ?1, ?1)").bind(t),
    ]);
    resetSearchIndexState(env.DB_STEPWISE);
    expect(await ensureSearchIndex(env.DB_STEPWISE)).toBe(true);
    resetSearchIndexState(env.DB_STEPWISE);
    expect(await ensureSearchIndex(env.DB_STEPWISE)).toBe(true);
    const hits = await env.DB_STEPWISE.prepare("SELECT text_id FROM text_fts WHERE text_fts MATCH 'backfilled'").all();
    expect(hits.results).toHaveLength(1);
  });

  it("re-applying is a no-op", async () => {
    const before = await dump(env.DB);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await dump(env.DB)).toEqual(before);
    const applied = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    expect(applied.results.map((r) => r.name)).toEqual(["0001_init.sql", "0002_search.sql", "0003_content.sql", "0004_uploads.sql", "0005_cleanup.sql", "0006_annotations.sql", "0007_version_reason.sql"]);
  });

  it("matches the reviewed schema snapshot (editing an applied migration fails here)", async () => {
    if (snapshot && Object.keys(snapshot).length === 0) console.log("SNAPSHOT" + JSON.stringify(await describeSchema(env.DB)));
    expect(await describeSchema(env.DB)).toEqual(snapshot);
  });

  it("has none of the legacy auth/ledger/approval columns", async () => {
    const all = Object.entries(await describeSchema(env.DB)).flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`));
    for (const banned of [/password/i, /reset/i, /token_allowance/i, /token_usage/i, /tokens_in/i, /api_usage/i, /session/i, /approved/i, /pending/i, /email(?!_enabled)/i]) {
      expect(all.filter((c) => banned.test(c.replace("texts.status", "")) && !c.startsWith("texts.status") ), String(banned)).toEqual([]);
    }
    expect(Object.keys(await describeSchema(env.DB))).not.toContain("users");
  });

  it("every foreign key to profiles cascades or nulls, so deleting a profile can never fail", async () => {
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results;
    const fks: string[] = [];
    for (const { name } of tables) {
      const list = (await env.DB.prepare(`SELECT "from" AS col, "table" AS ref, on_delete FROM pragma_foreign_key_list('${name}')`).all<{ col: string; ref: string; on_delete: string }>()).results;
      for (const fk of list) {
        if (fk.ref === "profiles") {
          fks.push(`${name}.${fk.col}`);
          expect(["CASCADE", "SET NULL"], `${name}.${fk.col}`).toContain(fk.on_delete);
        } else {
          expect(fk.on_delete, `${name}.${fk.col} -> ${fk.ref}`).toBe("CASCADE");
        }
      }
    }
    expect(fks.sort()).toEqual([
      "annotations.author_subject", "annotations.resolved_by", "invites.created_by", "invites.redeemed_by", "notification_preferences.subject",
      "notifications.subject", "project_members.subject", "projects.owner_subject", "text_versions.created_by",
    ]);
  });

  it("foreign keys are enforced", async () => {
    await expect(env.DB.prepare("INSERT INTO projects (id, owner_subject, name, created_at, updated_at, last_edited_at) VALUES ('x','cail-00000000000000000000000000000000','n','t','t','t')").run()).rejects.toThrow();
  });

  it("deleting a profile that owns data, annotated others' work and holds an invite succeeds", async () => {
    const A = "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B = "cail-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const t = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO profiles (subject) VALUES (?1), (?2)").bind(A, B),
      env.DB.prepare("INSERT INTO projects (id, owner_subject, name, created_at, updated_at, last_edited_at) VALUES ('p1', ?1, 'n', ?2, ?2, ?2), ('p2', ?3, 'n', ?2, ?2, ?2)").bind(A, t, B),
      env.DB.prepare("INSERT INTO project_members VALUES ('p1', ?1, 'owner', ?3), ('p2', ?2, 'owner', ?3), ('p2', ?1, 'editor', ?3)").bind(A, B, t),
      env.DB.prepare("INSERT INTO texts (id, project_id, name, created_at, updated_at) VALUES ('t2', 'p2', 'n', ?1, ?1)").bind(t),
      env.DB.prepare("INSERT INTO annotations (id, text_id, author_subject, anchor_type, body, created_at, updated_at) VALUES ('a1', 't2', ?1, 'global', 'b', ?2, ?2), ('a2', 't2', ?3, 'global', 'reply', ?2, ?2)").bind(A, t, B),
      env.DB.prepare("UPDATE annotations SET parent_id = 'a1' WHERE id = 'a2'"),
      env.DB.prepare("INSERT INTO text_versions (id, text_id, content_type, r2_key, created_by, created_at) VALUES ('v1', 't2', 'html', 'k', ?1, ?2)").bind(A, t),
      env.DB.prepare("INSERT INTO invites (id, project_id, token_hash, role, created_by, created_at, expires_at, redeemed_by, redeemed_at) VALUES ('i1', 'p2', 'h', 'editor', ?2, ?3, ?3, ?1, ?3)").bind(A, B, t),
    ]);
    await env.DB.prepare("DELETE FROM profiles WHERE subject = ?1").bind(A).run();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT created_by FROM text_versions").first<{ created_by: string | null }>())!.created_by).toBeNull();
    expect((await env.DB.prepare("SELECT redeemed_by FROM invites").first<{ redeemed_by: string | null }>())!.redeemed_by).toBeNull();
    // Alice's annotation and the reply threaded under it are both gone; nothing dangles.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM annotations").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("a second owner for a project is rejected by the schema", async () => {
    const A = "cail-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B = "cail-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const t = nowIso();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO profiles (subject) VALUES (?1), (?2)").bind(A, B),
      env.DB.prepare("INSERT INTO projects (id, owner_subject, name, created_at, updated_at, last_edited_at) VALUES ('p1', ?1, 'n', ?2, ?2, ?2)").bind(A, t),
      env.DB.prepare("INSERT INTO project_members VALUES ('p1', ?1, 'owner', ?2)").bind(A, t),
    ]);
    await expect(env.DB.prepare("INSERT INTO project_members VALUES ('p1', ?1, 'owner', ?2)").bind(B, t).run()).rejects.toThrow();
  });
});
