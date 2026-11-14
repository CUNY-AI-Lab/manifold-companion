// Stale-save protection. A read hands the client a revision token (`rev`) for
// each piece of editable content; a save may send it back as `base_rev`. When
// the content changed in between (another editor saved), the save is refused
// with 409 edit_conflict and a `result` that says who saved and when, and the
// current `rev`, so the client can offer to overwrite deliberately.
//
// Tokens:
//   - html / compiled / translation: the revision id of the stored object (the
//     last segment of its R2 key, a fresh UUID on every write), or "none";
//   - page text and summary (kept in D1): the first 32 hex digits of the
//     SHA-256 of the text ("" when there is none).
// A save without base_rev keeps the earlier behaviour (no check), so API
// callers that never read a rev are not broken; the browser sends it on every
// hand save.
import { AppError, E } from "./errors";

export const NO_CONTENT_REV = "none";

export function contentRev(key: string | null): string {
  return key ? key.slice(key.lastIndexOf("/") + 1) : NO_CONTENT_REV;
}

export async function textRev(text: string | null): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text ?? ""));
  return Array.from(new Uint8Array(digest).subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The base revision a save names, or undefined when it names none. */
export function baseRev(body: Record<string, unknown>): string | undefined {
  const b = body.base_rev;
  if (b === undefined || b === null) return undefined;
  if (typeof b !== "string" || b.length === 0 || b.length > 64) throw E.badRequest("base_rev must be the rev the content was loaded with.");
  return b;
}

export interface SavedBy { saved_at: string | null; saved_by: string | null }

/** Who last saved a versioned content kind: the newest version row was written by the save that produced the current content. */
export async function lastSave(db: D1Database, textId: string, kind: "html" | "compiled" | "page", fallbackAt: string | null, pageFilename: string | null = null): Promise<SavedBy> {
  const row = await db.prepare(
    `SELECT v.created_at, p.display_name FROM text_versions v LEFT JOIN profiles p ON p.subject = v.created_by
     WHERE v.text_id = ?1 AND v.content_type = ?2 AND (?3 IS NULL OR v.page_filename = ?3) ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`,
  ).bind(textId, kind, pageFilename).first<{ created_at: string; display_name: string | null }>();
  // No version row: the current content replaced nothing (a first write), so only the time is known.
  // (Rare imprecision: content emptied and written again after older versions names the older author.)
  if (row) return { saved_at: row.created_at, saved_by: row.display_name };
  return { saved_at: fallbackAt, saved_by: null };
}

/** Refuse a save whose base revision is not the current one. `who` is only looked up when the check fails. */
export async function requireBase(base: string | undefined, current: string, who: () => Promise<SavedBy>): Promise<void> {
  if (base === undefined || base === current) return;
  const saved = await who();
  throw new AppError({
    code: "edit_conflict",
    status: 409,
    message: "Someone saved this after you opened it. Your changes were not saved.",
    result: { rev: current, saved_at: saved.saved_at, saved_by: saved.saved_by },
  });
}
