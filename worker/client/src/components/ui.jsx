import { useEffect, useState } from 'react';
import { api } from '../api/client';

export function ErrorNote({ error, onDismiss }) {
  if (!error) return null;
  const message = typeof error === 'string' ? error : error.message;
  return (
    <div role="alert" className="my-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      {message}
      {error.retryAfter ? ` Try again in ${error.retryAfter} s.` : ''}
      {error.requestId ? <span className="block text-xs opacity-70">Reference {error.requestId}</span> : null}
      {onDismiss ? <button type="button" className="ml-2 underline" onClick={onDismiss}>Dismiss</button> : null}
    </div>
  );
}

export const Spinner = ({ label = 'Loading' }) => (
  <div className="flex items-center gap-2 py-8 text-sm text-slate-500 dark:text-slate-400" role="status">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-cail-blue border-t-transparent" aria-hidden="true" />
    {label}
  </div>
);

export const formatBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** The notice on every page that names what the tool must not hold. */
export function DataNotice() {
  return (
    <p className="text-xs text-slate-500 dark:text-slate-400">
      Do not upload material covered by FERPA, IRB protocols or HIPAA, or other personally identifiable information. This tool is not approved for it.
    </p>
  );
}

const OTHER = '__other__';

/**
 * Model menu for one task: the models the Worker's policy offers (from the live
 * Gateway catalog), plus "Another model…" for typing any catalog model id the
 * task can use; the Worker checks it before any spend.
 */
export function ModelPicker({ task, value, onChange, label }) {
  const [menu, setMenu] = useState(null);
  const [error, setError] = useState(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    api.get('/api/models').then((r) => setMenu(r.tasks[task]), setError);
  }, [task]);
  if (error) return <span className="text-xs text-red-700">Model list unavailable: {error.message}</span>;
  if (!menu) return <span className="text-xs text-slate-500 dark:text-slate-400">Loading models</span>;
  const listed = !value || menu.models.some((m) => m.id === value);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      <label>
        <span className="mr-2 text-slate-600 dark:text-slate-300">{label}</span>
        <select
          className="field inline-block w-auto"
          value={typing || !listed ? OTHER : value || ''}
          onChange={(e) => {
            if (e.target.value === OTHER) { setTyping(true); return; }
            setTyping(false);
            onChange(e.target.value || null);
          }}
        >
          <option value="">Default ({menu.default ?? 'none available'})</option>
          {menu.models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.reasoning ? ' (reasons)' : ''}</option>)}
          {menu.typeable > 0 ? <option value={OTHER}>Another model (type its id)</option> : null}
        </select>
      </label>
      {typing || !listed ? (
        <form className="inline-flex gap-1" onSubmit={(e) => { e.preventDefault(); const id = typed.trim(); if (id) { onChange(id); setTyping(false); } }}>
          <label className="sr-only" htmlFor={`model-id-${task}`}>Model id</label>
          <input id={`model-id-${task}`} className="field w-56" placeholder="catalog model id" value={typing ? typed : value ?? ''} onChange={(e) => { setTyping(true); setTyped(e.target.value); }} maxLength={100} />
          <button className="btn-quiet" type="submit">Use</button>
        </form>
      ) : null}
    </span>
  );
}

/** The Gateway's own estimate of the person's model allowance (delayed; not a ledger). */
export function QuotaLine() {
  const [quota, setQuota] = useState(null);
  const [state, setState] = useState('loading');
  useEffect(() => {
    api.get('/api/quota').then((r) => { setQuota(r.quota); setState('ok'); }, () => setState('unavailable'));
  }, []);
  if (state === 'loading') return null;
  if (state === 'unavailable' || !quota) return <span className="text-xs text-slate-500 dark:text-slate-400">Model allowance: not available right now</span>;
  const used = (quota.estimated_used ?? 0) / 1e6;
  const limit = (quota.limit ?? 0) / 1e6;
  return <span className="text-xs text-slate-600 dark:text-slate-300">Model allowance: about ${used.toFixed(2)} of ${limit.toFixed(2)} used this period (estimate, updates with a delay)</span>;
}

/**
 * Move-up / move-down buttons for one item of an ordered list. Plain buttons,
 * so they work from the keyboard; `idBase` gives them stable ids so focus can
 * be put back on the moved item after the list re-renders.
 */
export function MoveButtons({ label, index, total, onMove, idBase, disabled = false }) {
  return (
    <span className="inline-flex gap-1">
      <button id={`${idBase}-up`} type="button" className="btn-icon" aria-label={`Move ${label} up`} title="Move up" disabled={disabled || index === 0} onClick={() => onMove(index, 'up')}><span aria-hidden="true">↑</span></button>
      <button id={`${idBase}-down`} type="button" className="btn-icon" aria-label={`Move ${label} down`} title="Move down" disabled={disabled || index === total - 1} onClick={() => onMove(index, 'down')}><span aria-hidden="true">↓</span></button>
    </span>
  );
}

/** After a move re-renders the list, put focus back on the moved item's button (or its other one at an end). */
export function useMoveFocus(deps) {
  const [pending, setPending] = useState(null); // { idBase, dir }
  useEffect(() => {
    if (!pending) return;
    const want = document.getElementById(`${pending.idBase}-${pending.dir}`);
    const other = document.getElementById(`${pending.idBase}-${pending.dir === 'up' ? 'down' : 'up'}`);
    (want && !want.disabled ? want : other)?.focus();
    setPending(null);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return setPending;
}
