import { useState } from 'react';
import { useSession } from '../api/session.jsx';
import { ErrorNote } from './ui';

/** Shown until a person sets the name collaborators see (there is no name from sign-in). */
export default function DisplayNamePrompt() {
  const { session, updateProfile } = useSession();
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  if (!session || session.profile.display_name) return null;
  return (
    <section className="mb-6 rounded-md border border-cail-blue/30 bg-white p-4 dark:bg-slate-800">
      <h2 className="text-base">What should collaborators call you?</h2>
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Your name appears next to your comments and in member lists of projects you share. You can change it in Settings.</p>
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { await updateProfile({ display_name: name }); } catch (err) { setError(err); } }}>
        <label className="sr-only" htmlFor="display-name">Display name</label>
        <input id="display-name" className="field max-w-xs" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn-primary" type="submit">Save name</button>
      </form>
      <ErrorNote error={error} />
    </section>
  );
}
