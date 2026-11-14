import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorNote } from './ui';
import { isRangeAnchor, locate, makeAnchor } from '../lib/anchor';
import { formatWhen } from '../lib/versions';
import { useConfirm } from './ConfirmDialog';

const COUNT_EVENT = 'manifold-companion:comments';

/** "3 minutes ago", "yesterday", or the date: comments read as a conversation. */
export function relativeTime(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return formatWhen(iso);
}

const When = ({ iso }) => <time dateTime={iso} title={formatWhen(iso)} className="text-xs text-slate-600 dark:text-slate-300">{relativeTime(iso)}</time>;

/** A link to the comments of this text, with the number open; put it near the editor. */
export function CommentsJumpLink({ textId }) {
  const [count, setCount] = useState(null);
  useEffect(() => {
    let live = true;
    api.get(`/api/texts/${textId}/annotations`).then((r) => { if (live) setCount(r.annotations.length); }, () => {});
    const on = (e) => { if (e.detail?.textId === textId) setCount(e.detail.open); };
    window.addEventListener(COUNT_EVENT, on);
    return () => { live = false; window.removeEventListener(COUNT_EVENT, on); };
  }, [textId]);
  return <a href="#comments-title" className="text-sm">Comments{count === null ? '' : ` (${count})`}</a>;
}

/**
 * Comments on a text (legacy roles: viewers read; editors write, reply and
 * resolve; anyone edits their own). A comment can be anchored to a stretch of
 * the text being edited (`source`: the current text, its page and its
 * textarea); after edits the quote is found again by its context, or the
 * comment is shown as detached. Everything from other people (bodies, quotes)
 * is rendered as plain text.
 */
export default function CommentsPanel({ textId, canWrite, source = null, pages = [], onGoToPage, onNeedSource }) {
  const confirm = useConfirm();
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
  const load = useCallback(() => api.get(`/api/texts/${textId}/annotations${showResolved ? '?resolved=1' : ''}`).then((r) => {
    setItems(r.annotations);
    window.dispatchEvent(new CustomEvent(COUNT_EVENT, { detail: { textId, open: r.annotations.filter((a) => !a.resolved).length } }));
  }, setError), [textId, showResolved]);
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
  // Deleting someone else's comment (an owner may) or a comment with replies is said out loud first.
  const remove = async (a, isReply = false) => {
    const theirs = !a.mine;
    const what = isReply ? 'this reply' : a.reply_count ? `this comment and its ${a.reply_count === 1 ? 'reply' : `${a.reply_count} replies`}` : 'this comment';
    if (!(await confirm({ title: isReply ? 'Delete this reply?' : 'Delete this comment?', message: `Delete ${what}${theirs ? ` by ${a.author_name || 'another member'}` : ''}? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/texts/${textId}/annotations/${a.id}`);
      if (isReply) { await openThread(open); }
      if (!isReply && open === a.id) setOpen(null);
      load();
    } catch (e) { setError(e); }
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
                <p><span className="font-medium">{a.author_name || 'A member'}</span> <When iso={a.created_at} />: <span className="whitespace-pre-wrap">{a.body}</span>{a.resolved ? <span className="ml-1 rounded bg-slate-200 px-1 text-xs dark:bg-slate-700">Resolved</span> : null}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-3 text-xs">
                {w?.range ? <button type="button" className="underline" onClick={() => showInText(w.range)}>Show in text</button> : null}
                {w?.otherPage && onGoToPage ? <button type="button" className="underline" onClick={() => onGoToPage(w.otherPage.id)}>Go to page {w.otherPage.page_number}</button> : null}
                <button type="button" className="underline" onClick={() => (open === a.id ? setOpen(null) : openThread(a.id))}>{open === a.id ? 'Hide replies' : `Replies (${a.reply_count})`}</button>
                {canWrite ? <button type="button" className="underline" onClick={async () => { try { await api.post(`/api/texts/${textId}/annotations/${a.id}/${a.resolved ? 'unresolve' : 'resolve'}`); load(); } catch (e) { setError(e); } }}>{a.resolved ? 'Reopen' : 'Resolve'}</button> : null}
                {a.mine && editing?.id !== a.id ? <button type="button" className="underline" onClick={() => setEditing({ id: a.id, body: a.body })}>Edit</button> : null}
                {a.can_delete ?? a.mine ? <button type="button" className="underline" onClick={() => remove(a)}>Delete<span className="sr-only"> the comment by {a.author_name || 'a member'}</span></button> : null}
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
                      ) : (
                        <>
                          <span className="font-medium">{r.author_name || 'A member'}</span> <When iso={r.created_at} />: <span className="whitespace-pre-wrap">{r.body}</span>
                          <span className="ml-2 inline-flex gap-3 text-xs">
                            {r.mine ? <button type="button" className="underline" onClick={() => setEditing({ id: r.id, body: r.body })}>Edit<span className="sr-only"> your reply</span></button> : null}
                            {r.can_delete ?? r.mine ? <button type="button" className="underline" onClick={() => remove(r, true)}>Delete<span className="sr-only"> the reply by {r.author_name || 'a member'}</span></button> : null}
                          </span>
                        </>
                      )}
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
