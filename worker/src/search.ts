import type { Env } from "./env";

// FTS5 objects, created at runtime (see migrations/0002_search.sql for why).
// Every statement is idempotent. The backfill indexes texts that already have
// extracted text, so turning FTS on later loses nothing.
const FTS_DDL = [
  "CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5 (text_id UNINDEXED, project_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2')",
  "CREATE TRIGGER IF NOT EXISTS texts_fts_delete AFTER DELETE ON texts BEGIN DELETE FROM text_fts WHERE text_id = old.id; END",
  "CREATE TRIGGER IF NOT EXISTS texts_fts_rename AFTER UPDATE OF name ON texts BEGIN UPDATE text_fts SET title = new.name WHERE text_id = new.id; END",
  "INSERT INTO text_fts (text_id, project_id, title, body) SELECT t.id, t.project_id, t.name, t.search_text FROM texts t WHERE t.search_text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM text_fts f WHERE f.text_id = t.id)",
];
const RETRY_UNAVAILABLE_MS = 10 * 60_000;
const ftsState = new WeakMap<D1Database, { ok: boolean; at: number } | Promise<boolean>>();

/**
 * Make sure the FTS5 index exists, once per isolate per database. Returns false
 * (and remembers it for ten minutes) when FTS5 is unavailable, so callers fall
 * back to the plain-text column without paying for a failing DDL every request.
 */
export async function ensureSearchIndex(db: D1Database, now = Date.now()): Promise<boolean> {
  const state = ftsState.get(db);
  if (state instanceof Promise) return state;
  if (state && (state.ok || now - state.at < RETRY_UNAVAILABLE_MS)) return state.ok;
  const attempt = (async () => {
    try {
      await db.batch(FTS_DDL.map((sql) => db.prepare(sql)));
      ftsState.set(db, { ok: true, at: now });
      return true;
    } catch {
      ftsState.set(db, { ok: false, at: now });
      return false;
    }
  })();
  ftsState.set(db, attempt);
  return attempt;
}

/** For tests: forget what this isolate learned about a database's FTS support. */
export const resetSearchIndexState = (db: D1Database): void => void ftsState.delete(db);

export interface SearchHit {
  text_id: string;
  text_name: string;
  project_id: string;
  project_name: string;
  project_type: string;
  access_role: string;
  updated_at: string;
  snippet: string | null;
}

/** FTS5 query from free text: unicode word tokens, each quoted and prefix-matched, AND-ed. */
export function ftsQuery(q: string): string | null {
  const tokens = q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
  return tokens.length === 0 ? null : tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" ");
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The LIKE fallback: plain text only (never HTML), same membership scoping. */
async function likeSearch(env: Env, subject: string, q: string): Promise<SearchHit[]> {
  const pattern = `%${escapeLike(q)}%`;
  const rows = await env.DB.prepare(
    `SELECT t.id AS text_id, t.name AS text_name, p.id AS project_id, p.name AS project_name, p.project_type, m.role AS access_role, t.updated_at,
            substr(t.search_text, max(1, instr(lower(t.search_text), lower(?3)) - 40), 160) AS snippet
     FROM texts t JOIN projects p ON p.id = t.project_id JOIN project_members m ON m.project_id = p.id AND m.subject = ?1
     WHERE t.name LIKE ?2 ESCAPE '\\' OR t.summary LIKE ?2 ESCAPE '\\' OR p.name LIKE ?2 ESCAPE '\\' OR t.search_text LIKE ?2 ESCAPE '\\'
     ORDER BY t.updated_at DESC LIMIT 50`,
  )
    .bind(subject, pattern, q)
    .all<SearchHit>();
  return rows.results;
}

/**
 * ONE function behind which the search backend lives. Prefers FTS5; if the
 * index is unavailable (FTS5 not supported on the deployed D1, damaged table)
 * it degrades to a LIKE scan of the extracted plain-text column.
 */
export async function searchTexts(env: Env, subject: string, q: string): Promise<{ hits: SearchHit[]; backend: "fts5" | "like" }> {
  const match = ftsQuery(q);
  if (match !== null && (await ensureSearchIndex(env.DB))) {
    try {
      const rows = await env.DB.prepare(
        `SELECT t.id AS text_id, t.name AS text_name, p.id AS project_id, p.name AS project_name, p.project_type, m.role AS access_role, t.updated_at,
                snippet(text_fts, 3, '', '', '…', 16) AS snippet
         FROM text_fts f JOIN texts t ON t.id = f.text_id JOIN projects p ON p.id = t.project_id
         JOIN project_members m ON m.project_id = p.id AND m.subject = ?1
         WHERE text_fts MATCH ?2 ORDER BY rank LIMIT 50`,
      )
        .bind(subject, match)
        .all<SearchHit>();
      return { hits: rows.results, backend: "fts5" };
    } catch {
      // fall through to LIKE
    }
  }
  return { hits: await likeSearch(env, subject, q), backend: "like" };
}
