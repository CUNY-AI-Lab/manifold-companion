import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

function displayName(item) {
  return item.user_display_name || item.user_email;
}

function initials(item) {
  const name = item.user_display_name || item.user_email || '?';
  if (name.includes('@')) {
    const parts = name.split('@')[0].split(/[._-]/);
    return parts.map(p => p[0]?.toUpperCase() || '').join('').slice(0, 2);
  }
  const parts = name.trim().split(/\s+/);
  return parts.map(p => p[0]?.toUpperCase() || '').join('').slice(0, 2);
}

// Render body text with @mentions highlighted
function renderBody(body, mentions, memberMap) {
  if (!mentions || mentions.length === 0 || !memberMap) {
    return body;
  }
  const mentionNames = new Set();
  for (const uid of mentions) {
    const u = memberMap[uid];
    if (u) {
      if (u.display_name) mentionNames.add(u.display_name);
      mentionNames.add(u.email);
    }
  }
  if (mentionNames.size === 0) return body;

  const escaped = [...mentionNames].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`@(${escaped.join('|')})`, 'g');

  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={match.index} className="text-cail-blue font-medium">
        @{match[1]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }
  return parts.length > 0 ? parts : body;
}

// Textarea with @mention autocomplete
function MentionTextarea({ value, onChange, onMention, members, placeholder, rows, className, inputRef }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [query, setQuery] = useState('');
  const [atIndex, setAtIndex] = useState(-1);

  function handleChange(e) {
    const val = e.target.value;
    onChange(val);

    const cursor = e.target.selectionStart;
    const textBefore = val.slice(0, cursor);
    const lastAt = textBefore.lastIndexOf('@');

    if (lastAt >= 0) {
      const charBefore = lastAt > 0 ? textBefore[lastAt - 1] : ' ';
      if (lastAt === 0 || /\s/.test(charBefore)) {
        const q = textBefore.slice(lastAt + 1);
        if (!q.includes('\n')) {
          setQuery(q.toLowerCase());
          setAtIndex(lastAt);
          setShowDropdown(true);
          return;
        }
      }
    }
    setShowDropdown(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape' && showDropdown) {
      setShowDropdown(false);
      e.stopPropagation();
    }
  }

  function selectMember(member) {
    const name = member.display_name || member.email;
    const before = value.slice(0, atIndex);
    const after = value.slice(atIndex + 1 + query.length);
    const newVal = `${before}@${name} ${after}`;
    onChange(newVal);
    onMention(member.id);
    setShowDropdown(false);

    setTimeout(() => {
      if (inputRef?.current) {
        const pos = atIndex + name.length + 2;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  }

  const filtered = members.filter(m => {
    if (!query) return true;
    const name = (m.display_name || '').toLowerCase();
    const email = m.email.toLowerCase();
    return name.includes(query) || email.includes(query);
  }).slice(0, 6);

  return (
    <div className="relative">
      <textarea
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
      {showDropdown && filtered.length > 0 && (
        <div className="absolute z-50 bottom-full mb-1 left-0 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg max-h-40 overflow-y-auto">
          {filtered.map(m => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); selectMember(m); }}
              className="w-full text-left px-3 py-2 hover:bg-cail-blue/5 transition-colors flex items-center gap-2"
            >
              <span className="w-6 h-6 rounded-full bg-cail-navy text-white flex items-center justify-center text-[10px] font-display font-semibold shrink-0">
                {initials({ user_display_name: m.display_name, user_email: m.email })}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-cail-dark dark:text-slate-200 truncate">{m.display_name || m.email}</p>
                {m.display_name && <p className="text-xs text-gray-400 dark:text-slate-500 truncate">{m.email}</p>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline reply input with @mention support
function MentionInput({ value, onChange, onMention, members, placeholder, className, inputRef }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [query, setQuery] = useState('');
  const [atIndex, setAtIndex] = useState(-1);

  function handleChange(e) {
    const val = e.target.value;
    onChange(val);

    const cursor = e.target.selectionStart;
    const textBefore = val.slice(0, cursor);
    const lastAt = textBefore.lastIndexOf('@');

    if (lastAt >= 0) {
      const charBefore = lastAt > 0 ? textBefore[lastAt - 1] : ' ';
      if (lastAt === 0 || /\s/.test(charBefore)) {
        const q = textBefore.slice(lastAt + 1);
        if (!q.includes(' ')) {
          setQuery(q.toLowerCase());
          setAtIndex(lastAt);
          setShowDropdown(true);
          return;
        }
      }
    }
    setShowDropdown(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape' && showDropdown) {
      setShowDropdown(false);
      e.stopPropagation();
    }
  }

  function selectMember(member) {
    const name = member.display_name || member.email;
    const before = value.slice(0, atIndex);
    const after = value.slice(atIndex + 1 + query.length);
    const newVal = `${before}@${name} ${after}`;
    onChange(newVal);
    onMention(member.id);
    setShowDropdown(false);
    setTimeout(() => {
      if (inputRef?.current) {
        const pos = atIndex + name.length + 2;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  }

  const filtered = members.filter(m => {
    if (!query) return true;
    const name = (m.display_name || '').toLowerCase();
    const email = m.email.toLowerCase();
    return name.includes(query) || email.includes(query);
  }).slice(0, 6);

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
        placeholder={placeholder}
        className={className}
      />
      {showDropdown && filtered.length > 0 && (
        <div className="absolute z-50 bottom-full mb-1 left-0 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg max-h-32 overflow-y-auto">
          {filtered.map(m => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); selectMember(m); }}
              className="w-full text-left px-3 py-1.5 hover:bg-cail-blue/5 transition-colors"
            >
              <span className="text-xs font-medium text-cail-dark dark:text-slate-200">{m.display_name || m.email}</span>
              {m.display_name && <span className="text-xs text-gray-400 dark:text-slate-500 ml-1">{m.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReplyItem({ reply, textId, currentUserEmail, role, onRefresh, members, memberMap }) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(reply.body);
  const [saving, setSaving] = useState(false);
  const canEdit = reply.user_email === currentUserEmail;
  const canDelete = role === 'owner' || reply.user_email === currentUserEmail;

  async function handleSaveEdit() {
    if (!editBody.trim() || saving) return;
    setSaving(true);
    try {
      await api.put(`/api/texts/${textId}/annotations/${reply.id}`, { body: editBody.trim() });
      setEditing(false);
      onRefresh();
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function handleDelete() {
    if (!confirm('Delete this reply?')) return;
    try {
      await api.del(`/api/texts/${textId}/annotations/${reply.id}`);
      onRefresh();
    } catch { /* ignore */ }
  }

  return (
    <div className="mb-2 group">
      <div className="flex items-center gap-1">
        <span className="w-6 h-6 rounded-full bg-cail-teal/20 text-cail-teal flex items-center justify-center text-[10px] font-display font-semibold">
          {initials(reply)}
        </span>
        <span className="text-xs font-medium text-cail-dark dark:text-slate-200">{displayName(reply)}</span>
        <span className="text-[10px] text-gray-400 dark:text-slate-500">{formatTime(reply.created_at)}</span>
      </div>
      {editing ? (
        <div className="mt-1">
          <textarea
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            rows={2}
            className="w-full text-xs border border-gray-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-cail-blue resize-none"
          />
          <div className="flex gap-1 mt-1">
            <button onClick={handleSaveEdit} disabled={!editBody.trim() || saving} className="text-[10px] text-cail-blue hover:underline disabled:opacity-50">Save</button>
            <button onClick={() => { setEditing(false); setEditBody(reply.body); }} className="text-[10px] text-gray-400 dark:text-slate-500 hover:underline">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-cail-dark dark:text-slate-200 mt-0.5 whitespace-pre-wrap">
            {renderBody(reply.body, reply.mentions, memberMap)}
          </p>
          <div className="flex gap-2 mt-0.5">
            {canEdit && (
              <button onClick={() => setEditing(true)} className="text-[10px] text-gray-400 dark:text-slate-500 hover:text-cail-blue">Edit</button>
            )}
            {canDelete && (
              <button onClick={handleDelete} className="text-[10px] text-gray-400 dark:text-slate-500 hover:text-red-500">Delete</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AnnotationItem({ annotation, textId, role, currentUserEmail, onRefresh, members, memberMap }) {
  const [showReplies, setShowReplies] = useState(false);
  const [replies, setReplies] = useState([]);
  const [replyBody, setReplyBody] = useState('');
  const [replyMentions, setReplyMentions] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(annotation.body);
  const [savingEdit, setSavingEdit] = useState(false);
  const replyRef = useRef(null);

  const canResolve = role === 'owner' || role === 'editor';
  const canEdit = annotation.user_email === currentUserEmail;
  const canDelete = role === 'owner' || annotation.user_email === currentUserEmail;

  async function loadReplies() {
    try {
      const res = await api.get(`/api/texts/${textId}/annotations/${annotation.id}`);
      setReplies(res.replies || []);
    } catch {
      // ignore
    }
  }

  async function toggleReplies() {
    if (!showReplies) await loadReplies();
    setShowReplies(!showReplies);
  }

  async function submitReply(e) {
    e.preventDefault();
    if (!replyBody.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/api/texts/${textId}/annotations/${annotation.id}/replies`, {
        body: replyBody.trim(),
        mentions: [...new Set(replyMentions)],
      });
      setReplyBody('');
      setReplyMentions([]);
      await loadReplies();
    } catch {
      // ignore
    }
    setSubmitting(false);
  }

  async function handleSaveEdit() {
    if (!editBody.trim() || savingEdit) return;
    setSavingEdit(true);
    try {
      await api.put(`/api/texts/${textId}/annotations/${annotation.id}`, { body: editBody.trim() });
      setEditing(false);
      onRefresh();
    } catch { /* ignore */ }
    setSavingEdit(false);
  }

  async function toggleResolve() {
    const endpoint = annotation.resolved
      ? `/api/texts/${textId}/annotations/${annotation.id}/unresolve`
      : `/api/texts/${textId}/annotations/${annotation.id}/resolve`;
    try {
      await api.post(endpoint);
      onRefresh();
    } catch {
      // ignore
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this annotation?')) return;
    try {
      await api.del(`/api/texts/${textId}/annotations/${annotation.id}`);
      onRefresh();
    } catch {
      // ignore
    }
  }

  return (
    <div className={`rounded-2xl border p-4 mb-3 ${annotation.resolved ? 'bg-gray-50 dark:bg-slate-800/50 border-gray-200 dark:border-slate-700 opacity-70' : 'bg-white dark:bg-slate-800 border-cail-blue/20'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-full bg-cail-navy text-white flex items-center justify-center text-xs font-display font-semibold">
            {initials(annotation)}
          </span>
          <div>
            <span className="text-sm font-medium text-cail-dark dark:text-slate-200">{displayName(annotation)}</span>
            <span className="text-xs text-gray-400 dark:text-slate-500 ml-2">{formatTime(annotation.created_at)}</span>
          </div>
        </div>
        {!!annotation.resolved && (
          <span className="text-xs bg-cail-teal/10 text-cail-teal px-2 py-0.5 rounded-full font-medium">Resolved</span>
        )}
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            rows={3}
            className="w-full text-sm border border-gray-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-cail-blue resize-none"
          />
          <div className="flex gap-2 mt-1">
            <button onClick={handleSaveEdit} disabled={!editBody.trim() || savingEdit} className="text-xs text-cail-blue hover:underline disabled:opacity-50">
              {savingEdit ? 'Saving...' : 'Save'}
            </button>
            <button onClick={() => { setEditing(false); setEditBody(annotation.body); }} className="text-xs text-gray-400 hover:underline">Cancel</button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-cail-dark dark:text-slate-200 whitespace-pre-wrap">
          {renderBody(annotation.body, annotation.mentions, memberMap)}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3 text-xs">
        <button onClick={toggleReplies} className="text-cail-blue hover:underline">
          {showReplies ? 'Hide replies' : 'Replies'}
        </button>
        {canEdit && !editing && (
          <button onClick={() => setEditing(true)} className="text-gray-400 hover:text-cail-blue">Edit</button>
        )}
        {canResolve && (
          <button onClick={toggleResolve} className="text-cail-teal hover:underline">
            {annotation.resolved ? 'Unresolve' : 'Resolve'}
          </button>
        )}
        {canDelete && (
          <button onClick={handleDelete} className="text-red-500 hover:underline">Delete</button>
        )}
      </div>

      {showReplies && (
        <div className="mt-3 ml-4 border-l-2 border-cail-blue/10 pl-3">
          {replies.length === 0 && <p className="text-xs text-gray-400">No replies yet.</p>}
          {replies.map(r => (
            <ReplyItem
              key={r.id}
              reply={r}
              textId={textId}
              currentUserEmail={currentUserEmail}
              role={role}
              onRefresh={loadReplies}
              members={members}
              memberMap={memberMap}
            />
          ))}
          {role !== 'viewer' && (
            <form onSubmit={submitReply} className="mt-2 flex gap-2">
              <MentionInput
                value={replyBody}
                onChange={setReplyBody}
                onMention={(id) => setReplyMentions(prev => [...prev, id])}
                members={members}
                placeholder="Reply... (@ to mention)"
                className="w-full text-xs border border-gray-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-cail-blue"
                inputRef={replyRef}
              />
              <button
                type="submit"
                disabled={!replyBody.trim() || submitting}
                className="text-xs bg-cail-blue text-white px-2 py-1 rounded-lg disabled:opacity-50"
              >
                Send
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

export default function AnnotationSidebar({ textId, open, onClose, role }) {
  const { user } = useAuth();
  const currentUserEmail = user?.email || '';
  const [annotations, setAnnotations] = useState([]);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [newBody, setNewBody] = useState('');
  const [newMentions, setNewMentions] = useState([]);
  const [showNewForm, setShowNewForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [members, setMembers] = useState([]);
  const [memberMap, setMemberMap] = useState({});
  const newCommentRef = useRef(null);

  const fetchAnnotations = useCallback(async () => {
    if (!textId) return;
    setLoading(true);
    try {
      const resolved = showResolved ? 1 : 0;
      const res = await api.get(`/api/texts/${textId}/annotations?resolved=${resolved}`);
      setAnnotations(res.annotations || res || []);
      if (res.mentioned_users) setMemberMap(res.mentioned_users);
    } catch {
      setAnnotations([]);
    }
    setLoading(false);
  }, [textId, showResolved]);

  useEffect(() => {
    if (open) {
      fetchAnnotations();
      api.get(`/api/texts/${textId}/mentions/users`).then(res => {
        setMembers(res.users || []);
        const map = {};
        for (const u of (res.users || [])) map[u.id] = { display_name: u.display_name, email: u.email };
        setMemberMap(prev => ({ ...prev, ...map }));
      }).catch(() => {});
    }
  }, [open, fetchAnnotations, textId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function submitNew(e) {
    e.preventDefault();
    if (!newBody.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/api/texts/${textId}/annotations`, {
        anchor_type: 'global',
        anchor_data: {},
        body: newBody.trim(),
        mentions: [...new Set(newMentions)],
      });
      setNewBody('');
      setNewMentions([]);
      setShowNewForm(false);
      await fetchAnnotations();
    } catch {
      // ignore
    }
    setSubmitting(false);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full sm:max-w-md bg-cail-cream dark:bg-slate-900 h-full shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cail-blue/10 dark:border-slate-700">
          <h2 className="text-lg font-display font-semibold text-cail-navy dark:text-slate-200">Annotations</h2>
          <button onClick={onClose} className="text-gray-400 dark:text-slate-500 hover:text-cail-dark dark:hover:text-slate-200 text-xl leading-none">&times;</button>
        </div>

        {/* Controls */}
        <div className="px-5 py-3 flex items-center justify-between border-b border-cail-blue/10 dark:border-slate-700">
          <label className="flex items-center gap-2 text-sm text-cail-dark dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={e => setShowResolved(e.target.checked)}
              className="rounded border-gray-300 text-cail-blue focus:ring-cail-blue"
            />
            Show resolved
          </label>
          {role !== 'viewer' && (
            <button
              onClick={() => setShowNewForm(!showNewForm)}
              className="text-sm bg-cail-blue text-white px-3 py-1.5 rounded-2xl hover:bg-cail-navy transition-colors font-display"
            >
              New Comment
            </button>
          )}
        </div>

        {/* New comment form */}
        {showNewForm && (
          <form onSubmit={submitNew} className="px-5 py-3 border-b border-cail-blue/10 dark:border-slate-700">
            <MentionTextarea
              value={newBody}
              onChange={setNewBody}
              onMention={(id) => setNewMentions(prev => [...prev, id])}
              members={members}
              placeholder="Write a comment... (@ to mention)"
              rows={3}
              className="w-full border border-gray-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-cail-blue resize-none"
              inputRef={newCommentRef}
            />
            <div className="flex justify-end gap-2 mt-2">
              <button type="button" onClick={() => { setShowNewForm(false); setNewBody(''); setNewMentions([]); }} className="text-sm text-gray-500 hover:text-cail-dark">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newBody.trim() || submitting}
                className="text-sm bg-cail-teal text-white px-3 py-1 rounded-xl disabled:opacity-50"
              >
                {submitting ? 'Posting...' : 'Post'}
              </button>
            </div>
          </form>
        )}

        {/* Annotation list */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && <p className="text-sm text-gray-400 text-center py-8">Loading...</p>}
          {!loading && annotations.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">No annotations yet.</p>
          )}
          {annotations.map(a => (
            <AnnotationItem
              key={a.id}
              annotation={a}
              textId={textId}
              role={role}
              currentUserEmail={currentUserEmail}
              onRefresh={fetchAnnotations}
              members={members}
              memberMap={memberMap}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
