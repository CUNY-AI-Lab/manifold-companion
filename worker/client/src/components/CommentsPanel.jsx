import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorNote } from './ui';

/** Comments on a text (legacy roles: viewers read; editors write, reply and resolve). Plain text only. */
export default function CommentsPanel({ textId, canWrite }) {
  const [items, setItems] = useState([]);
  const [members, setMembers] = useState([]);
  const [open, setOpen] = useState(null);
  const [thread, setThread] = useState([]);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState([]);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get(`/api/texts/${textId}/annotations`).then((r) => setItems(r.annotations), setError), [textId]);
  useEffect(() => { load(); api.get(`/api/texts/${textId}/mentions`).then((r) => setMembers(r.users), () => {}); }, [load, textId]);
  const openThread = async (id) => { setOpen(id); setThread((await api.get(`/api/texts/${textId}/annotations/${id}`)).replies); };
  const send = async (e) => {
    e.preventDefault();
    try {
      if (open) await api.post(`/api/texts/${textId}/annotations/${open}/replies`, { body, mentions });
      else await api.post(`/api/texts/${textId}/annotations`, { anchor_type: 'global', body, mentions });
      setBody(''); setMentions([]); load(); if (open) openThread(open);
    } catch (err) { setError(err); }
  };
  return (
    <section aria-labelledby="comments-title" className="mt-8">
      <h2 id="comments-title" className="text-lg">Comments</h2>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      <ul className="rowlist mt-2 text-sm">
        {items.length === 0 ? <li className="py-2 text-slate-500">No open comments.</li> : null}
        {items.map((a) => (
          <li key={a.id} className="py-2">
            <p><span className="font-medium">{a.author_name || 'A member'}</span>: {a.body}</p>
            <div className="mt-1 flex gap-3 text-xs">
              <button type="button" className="underline" onClick={() => (open === a.id ? setOpen(null) : openThread(a.id))}>{open === a.id ? 'Hide replies' : `Replies (${a.reply_count})`}</button>
              {canWrite ? <button type="button" className="underline" onClick={async () => { await api.post(`/api/texts/${textId}/annotations/${a.id}/resolve`); load(); }}>Resolve</button> : null}
              {a.mine ? <button type="button" className="underline" onClick={async () => { await api.del(`/api/texts/${textId}/annotations/${a.id}`); load(); }}>Delete</button> : null}
            </div>
            {open === a.id ? <ul className="ml-4 mt-1 border-l border-slate-200 pl-3 dark:border-slate-700">{thread.map((r) => <li key={r.id} className="py-1"><span className="font-medium">{r.author_name || 'A member'}</span>: {r.body}</li>)}</ul> : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        <form className="mt-2 space-y-2" onSubmit={send}>
          <label className="label" htmlFor="comment-body">{open ? 'Reply' : 'New comment'}</label>
          <textarea id="comment-body" className="field" rows={3} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} required />
          {members.length > 1 ? (
            <fieldset className="text-xs"><legend className="mb-1">Mention</legend>{members.map((m) => <label key={m.subject} className="mr-3"><input type="checkbox" checked={mentions.includes(m.subject)} onChange={(e) => setMentions(e.target.checked ? [...mentions, m.subject] : mentions.filter((s) => s !== m.subject))} /> {m.display_name || 'Unnamed member'}</label>)}</fieldset>
          ) : null}
          <button className="btn-quiet" type="submit">{open ? 'Post reply' : 'Post comment'}</button>
        </form>
      ) : null}
    </section>
  );
}
