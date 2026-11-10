import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorNote, ModelPicker } from './ui';

// The Worker's task defaults (src/task-specs.ts TASK_DEFAULTS), shown as the value an empty field means.
const DEFAULTS = { image: { temperature: 0.1, max_tokens: 4096 }, pdf: { temperature: 0.1, max_tokens: 6000 } };
export const MAX_PROMPT = 3000;

/** The settings form's fields as the Worker takes them: empty means the default (null). Returns [body, error]. */
export function settingsBody(form, kind) {
  const temperature = form.temperature === '' ? null : Number(form.temperature);
  if (temperature !== null && !(Number.isFinite(temperature) && temperature >= 0 && temperature <= 1)) return [null, 'Temperature must be a number from 0 to 1.'];
  const maxTokens = form.max_tokens === '' ? null : Number(form.max_tokens);
  if (maxTokens !== null && !(Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 8192)) return [null, 'Maximum length must be a whole number from 1 to 8192.'];
  const body = { model: form.model || null, temperature, max_tokens: maxTokens };
  if (kind === 'image') body.prompt = form.prompt.trim() === '' ? null : form.prompt;
  else body.math_model = form.math_model || null;
  return [body, null];
}

/**
 * What a run will take from this text's saved settings, said next to the run
 * controls: the settings were saved by any editor and are paid from the
 * allowance of whoever runs, so they are shown before anything is spent.
 * Returns '' when nothing is saved that changes a run.
 */
export function savedRunNote(settings, kind) {
  if (!settings) return '';
  const parts = [];
  if (kind === 'image' && settings.prompt) parts.push('its own transcription prompt (it replaces the built-in one)');
  if (settings.temperature != null) parts.push(`temperature ${settings.temperature}`);
  if (settings.max_tokens != null) parts.push(`at most ${settings.max_tokens} tokens per page`);
  return parts.length ? `This text has saved model settings: ${parts.join(', ')}. See “Model settings for this text” below.` : '';
}

const toForm = (s = {}) => ({ model: s.model ?? null, math_model: s.math_model ?? null, temperature: s.temperature ?? '', max_tokens: s.max_tokens ?? '', prompt: s.prompt ?? '' });

/** Saved settings of one text, loaded once; the run pickers show the saved model as their default. */
export function useTextSettings(textId) {
  const [settings, setSettings] = useState(null);
  useEffect(() => { api.get(`/api/texts/${textId}/settings`).then((r) => setSettings(r.settings ?? {}), () => setSettings({})); }, [textId]);
  return [settings, setSettings];
}

/**
 * Per-text model settings (the legacy "settings"): the model used when a run
 * names none, the math model (PDF texts), temperature, maximum length and, for
 * image texts, the transcription prompt. Editors and owners change them.
 */
export default function TextSettingsPanel({ textId, kind, canEdit, settings, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(toForm(settings ?? {}));
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => { setForm(toForm(settings ?? {})); }, [settings]);
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setStatus(''); };
  const d = DEFAULTS[kind];
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    const [body, invalid] = settingsBody(form, kind);
    if (invalid) { setError({ message: invalid }); return; }
    try {
      const r = await api.post(`/api/texts/${textId}/settings`, body);
      onSaved(r.settings ?? {});
      setStatus('Settings saved for this text.');
    } catch (err) { setError(err); }
  };
  const reset = async () => {
    setError(null);
    try { await api.del(`/api/texts/${textId}/settings`); onSaved({}); setStatus('Back to the defaults.'); } catch (err) { setError(err); }
  };
  return (
    <section aria-labelledby={`settings-${textId}`} className="mt-6 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <h2 id={`settings-${textId}`} className="m-0 text-base">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>Model settings for this text</span><span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </h2>
      {open ? (
        <form noValidate className="space-y-3 border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-700" onSubmit={save}>
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <p className="text-xs text-slate-600 dark:text-slate-300">Used whenever a run on this text does not choose otherwise. Empty fields use the tool's defaults.{canEdit ? '' : ' You can read these; editors and owners can change them.'}</p>
          {settings === null ? <p role="status">Loading settings</p> : (
            <fieldset disabled={!canEdit} className="space-y-3">
              <legend className="sr-only">Settings</legend>
              <div className="flex flex-wrap gap-4">
                <ModelPicker task={kind === 'image' ? 'ocr' : 'html_page'} value={form.model} onChange={(v) => set('model', v)} label={kind === 'image' ? 'Model for reading pages' : 'Model for converting pages'} idSuffix="settings" />
                {kind === 'pdf' ? <ModelPicker task="html_math" value={form.math_model} onChange={(v) => set('math_model', v)} label="Model for math and table pages" idSuffix="settings" /> : null}
              </div>
              <div className="flex flex-wrap gap-4">
                <label><span className="label">Temperature (0 to 1)</span><input className="field w-32" type="number" inputMode="decimal" min="0" max="1" step="0.05" placeholder={`default ${d.temperature}`} value={form.temperature} onChange={(e) => set('temperature', e.target.value)} /></label>
                <label><span className="label">Maximum length (tokens)</span><input className="field w-40" type="number" inputMode="numeric" min="1" max="8192" step="1" placeholder={`default ${d.max_tokens}`} value={form.max_tokens} onChange={(e) => set('max_tokens', e.target.value)} /></label>
              </div>
              {kind === 'image' ? (
                <label className="block"><span className="label">Transcription prompt</span>
                  <textarea className="field min-h-[6rem]" maxLength={MAX_PROMPT} placeholder="Empty: the built-in prompt (TeX for formulas, Markdown structure, nothing added)" value={form.prompt} onChange={(e) => set('prompt', e.target.value)} />
                  <span className="text-xs text-slate-600 dark:text-slate-300">{form.prompt.length} of {MAX_PROMPT} characters. Replaces the built-in prompt for every page of this text.</span>
                </label>
              ) : null}
            </fieldset>
          )}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary" type="submit">Save settings</button>
              <button className="btn-quiet" type="button" onClick={reset}>Use the defaults</button>
              <span role="status" className="text-slate-600 dark:text-slate-300">{status}</span>
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
