import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorNote } from './ui';

/** Owner-only: invite links (role, expiry, single use), members, revoke and remove. */
export default function SharePanel({ projectId, onClose }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [role, setRole] = useState('viewer');
  const [days, setDays] = useState(7);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([api.get(`/api/projects/${projectId}/members`), api.get(`/api/projects/${projectId}/invites`)]);
      setMembers(m.members);
      setInvites(i.invites);
    } catch (e) { setError(e); }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e.preventDefault();
    try {
      const { invite } = await api.post(`/api/projects/${projectId}/invites`, { role, expires_in_days: Number(days) });
      setCreated(invite);
      load();
    } catch (err) { setError(err); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="share-title" className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div className="mt-12 w-full max-w-xl rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">
        <div className="flex items-center justify-between">
          <h2 id="share-title" className="text-lg">Share this project</h2>
          <button className="btn-quiet" type="button" onClick={onClose}>Close</button>
        </div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">An invite link works once, for the person who opens it first, until it expires. Anyone who uses it must have CUNY AI Lab access.</p>
        <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={create}>
          <label className="text-sm">
            <span className="label">Role</span>
            <select className="field" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="viewer">Viewer: can read and export</option>
              <option value="editor">Editor: can edit, upload and run models</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="label">Expires after (days)</span>
            <input className="field w-24" type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <button className="btn-primary" type="submit">Create invite link</button>
        </form>
        {created ? (
          <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">
            <p className="mb-1 font-medium">Copy this link now. It is shown only once.</p>
            <input aria-label="Invite link" readOnly className="field font-mono text-xs" value={created.url} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn-quiet mt-2" onClick={() => navigator.clipboard?.writeText(created.url)}>Copy link</button>
          </div>
        ) : null}
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <h3 className="mt-5 text-sm">Members</h3>
        <ul className="rowlist mt-1 text-sm">
          {members.map((m) => (
            <li key={m.subject} className="flex items-center justify-between py-2">
              <span>{m.display_name || 'Unnamed member'} <span className="text-slate-500">({m.role}{m.me ? ', you' : ''})</span></span>
              {m.role !== 'owner' ? <button type="button" className="btn-danger" onClick={async () => { try { await api.del(`/api/projects/${projectId}/members/${m.subject}`); load(); } catch (e) { setError(e); } }}>Remove</button> : null}
            </li>
          ))}
        </ul>
        <h3 className="mt-5 text-sm">Invite links</h3>
        <ul className="rowlist mt-1 text-sm">
          {invites.length === 0 ? <li className="py-2 text-slate-500">No invite links yet.</li> : null}
          {invites.map((i) => (
            <li key={i.id} className="flex items-center justify-between py-2">
              <span>{i.role}, {i.status}{i.status === 'redeemed' ? ` by ${i.redeemed_by_name || 'a member'}` : `, expires ${i.expires_at.slice(0, 10)}`}</span>
              {i.status === 'active' ? <button type="button" className="btn-quiet" onClick={async () => { try { await api.del(`/api/projects/${projectId}/invites/${i.id}`); load(); } catch (e) { setError(e); } }}>Revoke</button> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
