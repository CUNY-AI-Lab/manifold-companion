// A hand save names the revision (`rev`) the content was loaded with. When
// someone else saved in between, the Worker refuses with 409 edit_conflict and
// says who and when (src/revisions.ts); the person then chooses to replace that
// save with theirs, or to keep editing and look first. Nothing is replaced
// without that choice.

const when = (at) => {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : ` at ${d.toLocaleString()}`;
};

/** The dialog for a refused save (exported for tests). */
export function staleSaveQuestion(result, what, { history = true } = {}) {
  const who = result?.saved_by || 'Someone else';
  return {
    title: `${what[0].toUpperCase()}${what.slice(1)} was saved by someone else`,
    message: `${who} saved ${what}${when(result?.saved_at)}, after you opened it. Replace their version with yours? ${history ? 'Theirs stays in the version history, where you can compare and restore it.' : 'Theirs is not kept anywhere: copy anything you need from it first.'} Choose “Keep editing” to keep your changes here, unsaved, and reload to see theirs.`,
    confirmLabel: 'Replace with mine',
    cancelLabel: 'Keep editing',
    danger: true,
  };
}

/**
 * `send(baseRev)` performs the save. Returns its response, or throws: the
 * original error, or a "not saved" error when the person keeps editing.
 */
export async function saveFromBase({ send, base, confirm, what, history = true }) {
  try {
    return await send(base ?? undefined);
  } catch (e) {
    if (e?.code !== 'edit_conflict' || typeof e.result?.rev !== 'string') throw e;
    if (!(await confirm(staleSaveQuestion(e.result, what, { history })))) {
      const kept = new Error(`Not saved: ${e.result.saved_by || 'someone else'} saved ${what} after you opened it. Your changes are still here; reload to see theirs.`);
      kept.code = 'edit_conflict';
      kept.status = 409;
      throw kept;
    }
    return send(e.result.rev);
  }
}
