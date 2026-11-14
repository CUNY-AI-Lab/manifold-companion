import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useConfirm } from './ConfirmDialog';
import { ErrorNote } from './ui';

/**
 * A text's summary: written by hand or by the model, and always editable by
 * editors and owners (PUT /summary). A model summary replaces the current one,
 * so a summary someone wrote or corrected is never replaced without asking.
 */
export default function SummaryPanel({ text, canEdit, onSaved, busy = false }) {
  const confirm = useConfirm();
  const saved = text.summary ?? '';
  const [draft, setDraft] = useState(saved);
  const [working, setWorking] = useState('');
  const [status, setStatus] = useState('');
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setDraft(saved); }, [saved]);
  const dirty = draft !== saved;
  const hint = `summary-hint-${text.id}`;
  // The one summary save. `text` is what GET /texts/:id returned (its revision travels with it).
  const putSummary = (body) => api.put(`/api/texts/${text.id}/summary`, body);

  const save = async () => {
    setError(null);
    setWorking('Saving the summary');
    try {
      await putSummary({ summary: draft });
      setStatus('Summary saved.');
      setPartial(false);
      onSaved?.();
    } catch (e) { setError(e); } finally { setWorking(''); }
  };
  const generate = async () => {
    if ((saved.trim() || dirty) && !(await confirm({ title: 'Replace the summary?', message: `Write a new summary with the model? It replaces the current summary${dirty ? ', and your unsaved changes to it are lost' : ''}.`, confirmLabel: 'Write a new summary' }))) return;
    setError(null);
    setStatus('');
    setWorking('Writing a summary');
    try {
      const r = await api.post(`/api/texts/${text.id}/summary`, {});
      setDraft(r.summary ?? '');
      setPartial(!!r.truncated_input);
      setStatus('Summary written by the model. Read it, correct it here and save.');
      onSaved?.();
    } catch (e) { setError(e); } finally { setWorking(''); }
  };

  return (
    <section aria-labelledby={`summary-title-${text.id}`}>
      <h2 id={`summary-title-${text.id}`} className="text-lg">Summary</h2>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {partial ? (
        <p role="note" className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          This summary covers only the first part of the text: the text is longer than the model is sent, so the rest was not read.
        </p>
      ) : null}
      {canEdit ? (
        <>
          <label className="mt-1 block"><span className="sr-only">Summary of {text.name}</span>
            <textarea className="field min-h-[8rem] font-doc text-sm" value={draft} aria-describedby={hint} placeholder="No summary yet. Write one, or let the model write one." onChange={(e) => { setDraft(e.target.value); setStatus(''); }} />
          </label>
          <p id={hint} className="mt-1 text-xs text-slate-600 dark:text-slate-300">Shown with the text and found by search. Edit it as you like; the model never replaces it without asking.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className="btn-primary" type="button" disabled={!dirty || !!working} onClick={save}>Save summary</button>
            <button className="btn-quiet" type="button" disabled={!!working || busy} onClick={generate}>{saved.trim() ? 'Write a new summary' : 'Write a summary'}</button>
            <span role="status" className="text-sm text-slate-600 dark:text-slate-300">{working || status}</span>
          </div>
        </>
      ) : <p className="mt-1 whitespace-pre-wrap text-sm">{saved || 'No summary yet.'}</p>}
    </section>
  );
}
