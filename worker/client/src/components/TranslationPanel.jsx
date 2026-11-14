import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { saveFromBase } from '../lib/stale-save';
import { translateText } from '../lib/tasks';
import { useConfirm } from './ConfirmDialog';
import { ErrorNote } from './ui';
import { languageOptions } from '../../../src/languages.ts';

const LANGS = languageOptions();

/**
 * An image text's translation: made by the model chunk by chunk from the text
 * the export uses (`getSource`), then editable by editors and owners and saved
 * with PUT /translation. "Beside the original" shows the source and the
 * translation side by side for checking.
 */
export default function TranslationPanel({ text, canEdit, getSource, busy = false }) {
  const confirm = useConfirm();
  const [saved, setSaved] = useState(null); // null: none stored
  // The revision of the stored translation (GET /translation, then each save): sent as base_rev, so a translation saved by someone else meanwhile is not replaced unasked.
  const rev = useRef(undefined);
  const [draft, setDraft] = useState('');
  const [langs, setLangs] = useState({ source: text.source_language || 'auto-detect', target: text.target_language || 'en' });
  const [working, setWorking] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [beside, setBeside] = useState(false);
  const [original, setOriginal] = useState(null);
  useEffect(() => {
    api.get(`/api/texts/${text.id}/translation`).then((r) => { rev.current = r.rev; setSaved(r.translation ?? null); setDraft(r.translation ?? ''); }, () => {});
  }, [text.id]);
  useEffect(() => {
    if (!beside) return;
    getSource().then((s) => setOriginal(s), setError);
  }, [beside]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = draft !== (saved ?? '');
  // The one translation save, used by Save and by a model translation; it builds on `rev`.
  const putTranslation = async (body) => {
    const r = await saveFromBase({ send: (base_rev) => api.put(`/api/texts/${text.id}/translation`, { ...body, base_rev }), base: rev.current, confirm, what: 'the translation', history: false });
    rev.current = r.rev;
    return r;
  };

  const translate = async () => {
    if ((saved || dirty) && !(await confirm({ title: 'Replace the translation?', message: `Translate the text again with the model? It replaces the current translation${dirty ? ', and your unsaved changes to it are lost' : ''}.`, confirmLabel: 'Translate again' }))) return;
    setError(null);
    setStatus('');
    let source;
    try { source = await getSource(); } catch (e) { setError(e); return; }
    if (!source) { setError({ message: 'There is no text to translate yet.' }); return; }
    try {
      const t = await translateText({ textId: text.id, text: source, source: langs.source, target: langs.target, onProgress: ({ done, total }) => setWorking(`Translating part ${Math.min(done + 1, total)} of ${total}`), save: putTranslation });
      setSaved(t);
      setDraft(t);
      if (beside) setOriginal(source);
      setStatus('Translated by the model. Check it beside the original, correct it here and save.');
    } catch (e) { setError(e); } finally { setWorking(''); }
  };
  const save = async () => {
    setError(null);
    setWorking('Saving the translation');
    try {
      await putTranslation({ translation: draft, source_language: langs.source, target_language: langs.target });
      setSaved(draft);
      setStatus('Translation saved.');
    } catch (e) { setError(e); } finally { setWorking(''); }
  };

  const editor = canEdit ? (
    <label className="block"><span className={beside ? 'label' : 'sr-only'}>Translation</span>
      <textarea className="field min-h-[16rem] font-doc text-sm" value={draft} placeholder="No translation yet." onChange={(e) => { setDraft(e.target.value); setStatus(''); }} />
    </label>
  ) : saved ? <pre role="region" tabIndex={0} aria-label={`Translation of ${text.name}`} className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 p-3 font-doc text-sm dark:border-slate-700">{saved}</pre> : <p className="text-sm text-slate-500 dark:text-slate-400">No translation yet.</p>;

  return (
    <section aria-labelledby={`translation-title-${text.id}`}>
      <h2 id={`translation-title-${text.id}`} className="text-lg">Translation</h2>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {canEdit ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <label>From <select aria-label="Translate from" className="field inline-block w-auto" value={langs.source} onChange={(e) => setLangs({ ...langs, source: e.target.value })}><option value="auto-detect">Detect the language</option>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select></label>
          <label>to <select aria-label="Translate to" className="field inline-block w-auto" value={langs.target} onChange={(e) => setLangs({ ...langs, target: e.target.value })}>{LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}</select></label>
          <button className="btn-quiet" type="button" disabled={!!working || busy} onClick={translate}>{saved ? 'Translate again' : 'Translate'}</button>
        </div>
      ) : null}
      <label className="mt-2 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={beside} onChange={(e) => setBeside(e.target.checked)} /> Show beside the original</label>
      <div className={`mt-2 ${beside ? 'grid gap-3 lg:grid-cols-2' : ''}`}>
        {beside ? (
          <div className="flex flex-col gap-1">
            <span className="label" id={`original-title-${text.id}`}>Original (the text the export uses)</span>
            <pre role="region" tabIndex={0} aria-labelledby={`original-title-${text.id}`} className="max-h-[32rem] min-h-[16rem] overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 p-3 font-doc text-sm dark:border-slate-700">{original ?? 'Loading the original'}</pre>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">{editor}</div>
      </div>
      {canEdit ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className="btn-primary" type="button" disabled={!dirty || !!working} onClick={save}>Save translation</button>
          <span role="status" className="text-sm text-slate-600 dark:text-slate-300">{working || status}</span>
        </div>
      ) : null}
    </section>
  );
}
