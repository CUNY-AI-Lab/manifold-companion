import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';
import { ErrorNote, formatBytes, QuotaLine } from '../components/ui';
import { clearAllDrafts, countDrafts } from '../lib/drafts';
import { browserStorage } from '../lib/storage';
import { SingleKeyToggle } from '../hooks/useShortcuts';

const PREF_LABELS = { inapp_comment_reply: 'Replies to my comments', inapp_comment_mention: 'Mentions of me', inapp_project_shared: 'Someone joins a project I own' };

export default function SettingsPage() {
  const { session, updateProfile, draftOwner } = useSession();
  const [drafts, setDrafts] = useState(() => (draftOwner ? countDrafts(browserStorage(), draftOwner) : 0));
  useEffect(() => { if (draftOwner) setDrafts(countDrafts(browserStorage(), draftOwner)); }, [draftOwner]);
  const [name, setName] = useState(session.profile.display_name ?? '');
  const [prefs, setPrefs] = useState(null);
  const [confirm, setConfirm] = useState('');
  const [step, setStep] = useState(0);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/api/notifications/preferences').then((r) => setPrefs(r.preferences), setError); }, []);
  const run = (fn, done) => async (e) => { e?.preventDefault?.(); setError(null); try { await fn(); setMessage(done); } catch (err) { setError(err); } };

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-2xl">Settings</h1>
      {message ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
      <ErrorNote error={error} />
      <form onSubmit={run(() => updateProfile({ display_name: name }), 'Name saved.')} className="space-y-2">
        <h2 className="text-lg">Name</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">Collaborators see this next to your comments and in member lists.</p>
        <input className="field max-w-sm" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
        <button className="btn-primary" type="submit">Save name</button>
      </form>
      <section className="space-y-2">
        <h2 className="text-lg">Appearance</h2>
        {['system', 'light', 'dark'].map((t) => (
          <label key={t} className="mr-4 text-sm"><input type="radio" name="theme" checked={session.profile.theme_preference === t} onChange={run(() => updateProfile({ theme_preference: t }), 'Appearance saved.')} /> {t === 'system' ? 'Match my device' : t === 'light' ? 'Light' : 'Dark'}</label>
        ))}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg">Notifications in the app</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">Notifications appear here only; no email is sent.</p>
        {prefs ? Object.entries(PREF_LABELS).map(([k, label]) => (
          <label key={k} className="block text-sm"><input type="checkbox" checked={prefs[k]} onChange={run(async () => setPrefs((await api.put('/api/notifications/preferences', { [k]: !prefs[k] })).preferences), 'Notification settings saved.')} /> {label}</label>
        )) : null}
      </section>
      <section className="space-y-1 text-sm">
        <h2 className="text-lg">Usage</h2>
        <p>Storage: {formatBytes(session.storage.used_bytes)} of {formatBytes(session.storage.quota_bytes)} in projects you own (uploads by your collaborators count here too).</p>
        <QuotaLine />
      </section>
      <section className="space-y-2 text-sm">
        <h2 className="text-lg">Keyboard shortcuts</h2>
        <p>The list is under “Keyboard shortcuts” at the top of every page, and on the Help page. This setting is kept in this browser.</p>
        <SingleKeyToggle />
      </section>
      <section className="space-y-2 text-sm">
        <h2 className="text-lg">Unsaved changes kept in this browser</h2>
        <p>When you leave a text with changes that are not saved, this browser keeps a copy of them (for that text only) for 7 days and offers it when you open the text again. Saving or discarding removes it, and so does someone else signing in on this browser.</p>
        <p>{drafts === 0 ? 'None are kept now.' : `${drafts} text${drafts === 1 ? ' has' : 's have'} unsaved changes kept here.`}</p>
        <button type="button" className="btn-quiet" disabled={drafts === 0} onClick={run(async () => { clearAllDrafts(browserStorage()); setDrafts(0); }, 'Unsaved changes kept in this browser were deleted.')}>Delete them from this browser</button>
      </section>
      <section className="space-y-2 rounded-md border border-red-200 p-4 dark:border-red-900">
        <h2 className="text-lg text-red-800 dark:text-red-300">Delete my data</h2>
        <p className="text-sm">Deletes every project you own, with its files, and your comments everywhere. This cannot be undone. Export anything you want to keep first.</p>
        {step === 0 ? <button type="button" className="btn-danger" onClick={() => setStep(1)}>Delete my data</button> : (
          <form className="space-y-2" onSubmit={run(async () => { await api.del('/api/me/data', { confirm }); clearAllDrafts(browserStorage()); window.location.assign('./'); }, 'Deleted.')}>
            <label className="label" htmlFor="confirm-delete">Type “delete my data” to confirm</label>
            <input id="confirm-delete" className="field max-w-xs" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <div className="flex gap-2"><button className="btn-danger" type="submit" disabled={confirm !== 'delete my data'}>Delete everything</button><button className="btn-quiet" type="button" onClick={() => { setStep(0); setConfirm(''); }}>Keep my data</button></div>
          </form>
        )}
      </section>
    </div>
  );
}
