import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorNote } from './ui';
import { isRangeAnchor, locate, makeAnchor } from '../lib/anchor';

/**
 * Comments on a text (legacy roles: viewers read; editors write, reply and
 * resolve; anyone edits their own). A comment can be anchored to a stretch of
 * the text being edited (`source`: the current text, its page and its
 * textarea); after edits the quote is found again by its context, or the
 * comment is shown as detached. Everything from other people (bodies, quotes)
 * is rendered as plain text.
 */
export default function CommentsPanel({ textId, canWrite, source = null, pages = [], onGoToPage, onNeedSource }) {
  const [items, setItems] = useState([]);
  const [members, setMembers] = useState([]);
  const [open, setOpen] = useState(null);
  const [thread, setThread] = useState([]);
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState([]);
  const [anchor, setAnchor] = useState(null);
  const [showResolved, setShowResolved] = useState(false);
  const [editing, setEditing] = useState(null); // { id, body }
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get(`/api/texts/${textId}/annotations${showResolved ? '?resolved=1' : ''}`).then((r) => setItems(r.annotations), setError), [textId, showResolved]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get(`/api/texts/${textId}/mentions`).then((r) => setMembers(r.users), () => {}); }, [textId]);
  const openThread = async (id) => { setOpen(id); setThread((await api.get(`/api/texts/${textId}/annotations/${id}`)).replies); };

  const useSelection = () => {
    const el = source?.textareaRef?.current;
    if (!el) return;
    const a = makeAnchor(el.value, el.selectionStart, el.selectionEnd, source.pageId);
    if (!a) { setStatus('Select some text in the editor first.'); return; }
    setAnchor(a);
    setStatus('');
  };
  const selectRange = (range) => {
    const el = source?.textareaRef?.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(range.start, range.end);
    setStatus('The commented text is selected in the editor.');
  };
  // Comment ranges are places in the HTML source: from the visual editor, switch to it first.
  const showInText = (range) => {
    if (source?.selectable === false && onNeedSource) { onNeedSource(); setTimeout(() => selectRange(range), 60); return; }
    selectRange(range);
  };

  const send = async (e) => {
    e.preventDefault();
    try {
      if (open) await api.post(`/api/texts/${textId}/annotations/${open}/replies`, { body, mentions });
      else await api.post(`/api/texts/${textId}/annotations`, anchor ? { anchor_type: 'range', anchor_data: anchor, body, mentions } : { anchor_type: 'global', body, mentions });
      setBody(''); setMentions([]); setAnchor(null); load(); if (open) openThread(open);
    } catch (err) { setError(err); }
  };
  const saveEdit = async (e) => {
    e.preventDefault();
    try { await api.put(`/api/texts/${textId}/annotations/${editing.id}`, { body: editing.body }); setEditing(null); load(); if (open) openThread(open); } catch (err) { setError(err); }
  };

  const where = (a) => {
    if (a.anchor_type !== 'range') return null;
    const data = a.anchor_data;
    if (!isRangeAnchor(data)) return { detached: true };
    if (data.page_id && source && data.page_id !== source.pageId) {
      const page = pages.find((p) => p.id === data.page_id);
      return { otherPage: page ?? null, quote: data.quote };
    }
    const range = source ? locate(data, source.text) : null;
    return range ? { range, quote: data.quote } : { detached: true, quote: data.quote };
  };

  return (
    <section aria-labelledby="comments-title" className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="comments-title" className="text-lg">Comments</h2>
        <label className="text-sm"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved comments</label>
      </div>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      <p className="sr-only" role="status">{status}</p>
      <ul className="rowlist mt-2 text-sm">
        {items.length === 0 ? <li className="py-2 text-slate-600 dark:text-slate-300">{showResolved ? 'No comments.' : 'No open comments.'}</li> : null}
        {items.map((a) => {
          const w = where(a);
          return (
            <li key={a.id} className="py-2">
              {w?.quote !== undefined || w?.detached ? (
                <blockquote className="mb-1 border-l-4 border-slate-300 pl-2 text-slate-700 dark:border-slate-600 dark:text-slate-200">
                  {w.quote !== undefined ? <span className="line-clamp-3 whitespace-pre-wrap">“{w.quote}”</span> : null}
                  {w.detached ? <span className="block text-xs font-medium text-amber-800 dark:text-amber-300">Detached: the commented text was changed or removed.</span> : null}
                  {w.otherPage !== undefined ? <span className="block text-xs">On page {w.otherPage ? `${w.otherPage.page_number} (${w.otherPage.filename})` : 'that no longer exists'}</span> : null}
                </blockquote>
              ) : null}
              {editing?.id === a.id ? (
                <form className="space-y-1" onSubmit={saveEdit}>
                  <label className="sr-only" htmlFor={`edit-${a.id}`}>Edit your comment</label>
                  <textarea id={`edit-${a.id}`} className="field" rows={3} maxLength={10000} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} required />
                  <span className="flex gap-2"><button className="btn-quiet" type="submit">Save comment</button><button className="btn-quiet" type="button" onClick={() => setEditing(null)}>Cancel</button></span>
                </form>
              ) : (
                <p><span className="font-medium">{a.author_name || 'A member'}</span>: <span className="whitespace-pre-wrap">{a.body}</span>{a.resolved ? <span className="ml-1 rounded bg-slate-200 px-1 text-xs dark:bg-slate-700">Resolved</span> : null}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-3 text-xs">
                {w?.range ? <button type="button" className="underline" onClick={() => showInText(w.range)}>Show in text</button> : null}
                {w?.otherPage && onGoToPage ? <button type="button" className="underline" onClick={() => onGoToPage(w.otherPage.id)}>Go to page {w.otherPage.page_number}</button> : null}
                <button type="button" className="underline" onClick={() => (open === a.id ? setOpen(null) : openThread(a.id))}>{open === a.id ? 'Hide replies' : `Replies (${a.reply_count})`}</button>
                {canWrite ? <button type="button" className="underline" onClick={async () => { try { await api.post(`/api/texts/${textId}/annotations/${a.id}/${a.resolved ? 'unresolve' : 'resolve'}`); load(); } catch (e) { setError(e); } }}>{a.resolved ? 'Reopen' : 'Resolve'}</button> : null}
                {a.mine && editing?.id !== a.id ? <button type="button" className="underline" onClick={() => setEditing({ id: a.id, body: a.body })}>Edit</button> : null}
                {a.mine ? <button type="button" className="underline" onClick={async () => { try { await api.del(`/api/texts/${textId}/annotations/${a.id}`); load(); } catch (e) { setError(e); } }}>Delete</button> : null}
              </div>
              {open === a.id ? (
                <ul className="ml-4 mt-1 border-l border-slate-200 pl-3 dark:border-slate-700">
                  {thread.map((r) => (
                    <li key={r.id} className="py-1">
                      {editing?.id === r.id ? (
                        <form className="space-y-1" onSubmit={saveEdit}>
                          <label className="sr-only" htmlFor={`edit-${r.id}`}>Edit your reply</label>
                          <textarea id={`edit-${r.id}`} className="field" rows={2} maxLength={10000} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} required />
                          <span className="flex gap-2"><button className="btn-quiet" type="submit">Save reply</button><button className="btn-quiet" type="button" onClick={() => setEditing(null)}>Cancel</button></span>
                        </form>
                      ) : <><span className="font-medium">{r.author_name || 'A member'}</span>: <span className="whitespace-pre-wrap">{r.body}</span> {r.mine ? <button type="button" className="text-xs underline" onClick={() => setEditing({ id: r.id, body: r.body })}>Edit</button> : null}</>}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canWrite ? (
        <form className="mt-2 space-y-2" onSubmit={send}>
          <label className="label" htmlFor="comment-body">{open ? 'Reply' : 'New comment'}</label>
          {!open && source && source.selectable === false ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">To attach a comment to a stretch of the text, <button type="button" className="underline" onClick={onNeedSource}>switch to the HTML source</button> and select it there.</p>
          ) : null}
          {!open && source && source.selectable !== false ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button type="button" className="btn-quiet" onClick={useSelection}>Comment on the selected text</button>
              {anchor ? <><span className="line-clamp-1 max-w-md">On “{anchor.quote}”</span><button type="button" className="text-xs underline" onClick={() => setAnchor(null)}>Comment on the whole text instead</button></> : <span className="text-xs text-slate-600 dark:text-slate-300">Select words in the editor, then press this to attach the comment to them.</span>}
            </div>
          ) : null}
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
