// Wording for version history. A version is the content as it was just before
// an action replaced it; `reason` names that action and `created_by` the
// person who took it.

const REASONS = {
  save: 'Before a manual save',
  ocr: 'Before an OCR run',
  conversion: 'Before a PDF conversion',
  restore: 'Before a restore',
};

export function versionLabel(v, mySubject) {
  const what = REASONS[v.reason] ?? 'Earlier version';
  const who = v.created_by && v.created_by === mySubject ? 'you' : v.author_name || (v.created_by ? 'a collaborator' : 'a former member');
  return `${what} by ${who}`;
}

export const formatWhen = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** The confirmation every replacing action shows. */
export const replaceWarning = (action) => `${action} The current text will be saved as a version first; you can restore it from Version history.`;
