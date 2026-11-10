import type { Env } from "./env";

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
  if (match !== null) {
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
