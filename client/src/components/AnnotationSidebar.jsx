import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

function initials(email) {
  if (!email) return '?';
  const parts = email.split('@')[0].split(/[._-]/);
  return parts.map(p => p[0]?.toUpperCase() || '').join('').slice(0, 2);
}

function AnnotationItem({ annotation, textId, role, currentUserEmail, onRefresh }) {
  const [showReplies, setShowReplies] = useState(false);
  const [replies, setReplies] = useState([]);
  const [replyBody, setReplyBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canResolve = role === 'owner' || role === 'editor';
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
      await api.post(`/api/texts/${textId}/annotations/${annotation.id}/replies`, { body: replyBody.trim() });
      setReplyBody('');
      await loadReplies();
    } catch {
      // ignore
    }
    setSubmitting(false);
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
    <div className={`rounded-2xl border p-4 mb-3 ${annotation.resolved ? 'bg-gray-50 border-gray-200 opacity-70' : 'bg-white border-cail-blue/20'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-full bg-cail-navy text-white flex items-center justify-center text-xs font-display font-semibold">
            {initials(annotation.user_email)}
          </span>
          <div>
            <span className="text-sm font-medium text-cail-dark">{annotation.user_email}</span>
            <span className="text-xs text-gray-400 ml-2">{formatTime(annotation.created_at)}</span>
          </div>
        </div>
        {annotation.resolved && (
          <span className="text-xs bg-cail-teal/10 text-cail-teal px-2 py-0.5 rounded-full font-medium">Resolved</span>
        )}
      </div>

      <p className="mt-2 text-sm text-cail-dark whitespace-pre-wrap">{annotation.body}</p>

      <div className="mt-3 flex items-center gap-3 text-xs">
        <button onClick={toggleReplies} className="text-cail-blue hover:underline">
          {showReplies ? 'Hide replies' : 'Replies'}
        </button>
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
            <div key={r.id} className="mb-2">
              <div className="flex items-center gap-1">
                <span className="w-6 h-6 rounded-full bg-cail-teal/20 text-cail-teal flex items-center justify-center text-[10px] font-display font-semibold">
                  {initials(r.user_email)}
                </span>
                <span className="text-xs font-medium text-cail-dark">{r.user_email}</span>
                <span className="text-[10px] text-gray-400">{formatTime(r.created_at)}</span>
              </div>
              <p className="text-xs text-cail-dark mt-0.5 whitespace-pre-wrap">{r.body}</p>
            </div>
          ))}
          {role !== 'viewer' && (
            <form onSubmit={submitReply} className="mt-2 flex gap-2">
              <input
                type="text"
                value={replyBody}
                onChange={e => setReplyBody(e.target.value)}
                placeholder="Reply..."
                className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:border-cail-blue"
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
  const [annotations, setAnnotations] = useState([]);
  const [showResolved, setShowResolved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [newBody, setNewBody] = useState('');
  const [showNewForm, setShowNewForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState('');

  const fetchAnnotations = useCallback(async () => {
    if (!textId) return;
    setLoading(true);
    try {
      const resolved = showResolved ? 1 : 0;
      const res = await api.get(`/api/texts/${textId}/annotations?resolved=${resolved}`);
      setAnnotations(res.annotations || res || []);
    } catch {
      setAnnotations([]);
    }
    setLoading(false);
  }, [textId, showResolved]);

  useEffect(() => {
    if (open) {
      fetchAnnotations();
      api.get('/api/auth/me').then(res => {
        if (res?.user?.email) setCurrentUserEmail(res.user.email);
      }).catch(() => {});
    }
  }, [open, fetchAnnotations]);

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
      });
      setNewBody('');
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
      <div className="relative w-full max-w-md bg-cail-cream h-full shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cail-blue/10">
          <h2 className="text-lg font-display font-semibold text-cail-navy">Annotations</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-cail-dark text-xl leading-none">&times;</button>
        </div>

        {/* Controls */}
        <div className="px-5 py-3 flex items-center justify-between border-b border-cail-blue/10">
          <label className="flex items-center gap-2 text-sm text-cail-dark cursor-pointer">
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
          <form onSubmit={submitNew} className="px-5 py-3 border-b border-cail-blue/10">
            <textarea
              value={newBody}
              onChange={e => setNewBody(e.target.value)}
              placeholder="Write a comment..."
              rows={3}
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-cail-blue resize-none"
            />
            <div className="flex justify-end gap-2 mt-2">
              <button type="button" onClick={() => { setShowNewForm(false); setNewBody(''); }} className="text-sm text-gray-500 hover:text-cail-dark">
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
            />
          ))}
        </div>
      </div>
    </div>
  );
}
