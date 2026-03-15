import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = today - target;
  if (diff === 0) return 'Today';
  if (diff === 86400000) return 'Yesterday';
  if (diff < 604800000) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

const TYPE_META = {
  ocr_complete: {
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    color: 'text-emerald-500',
    bg: 'bg-emerald-50',
    label: 'OCR',
  },
  account_approved: {
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    color: 'text-cail-blue',
    bg: 'bg-cail-blue/5',
    label: 'Account',
  },
  project_shared: {
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    color: 'text-cail-azure',
    bg: 'bg-cail-teal/5',
    label: 'Shared',
  },
  comment_reply: {
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
      </svg>
    ),
    color: 'text-amber-500',
    bg: 'bg-amber-50',
    label: 'Reply',
  },
  comment_mention: {
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9" />
      </svg>
    ),
    color: 'text-violet-500',
    bg: 'bg-violet-50',
    label: 'Mention',
  },
};

const FALLBACK_META = {
  icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  color: 'text-gray-500',
  bg: 'bg-gray-50',
  label: 'Info',
};

function groupByDate(notifications) {
  const groups = [];
  let currentKey = null;
  for (const n of notifications) {
    const key = formatDate(n.created_at);
    if (key !== currentKey) {
      groups.push({ label: key, items: [] });
      currentKey = key;
    }
    groups[groups.length - 1].items.push(n);
  }
  return groups;
}

export default function NotificationsPage() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // 'all' | 'unread'
  const [prefs, setPrefs] = useState(null);
  const [prefsOpen, setPrefsOpen] = useState(false);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const params = filter === 'all' ? '?all=1&limit=200' : '?limit=200';
      const data = await api.get(`/api/notifications${params}`);
      setNotifications(data.notifications);
      setUnread(data.unread);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filter]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const handleClick = async (notif) => {
    if (!notif.read) {
      try {
        await api.post(`/api/notifications/${notif.id}/read`);
        setUnread((u) => Math.max(0, u - 1));
        setNotifications((prev) => prev.map((n) => n.id === notif.id ? { ...n, read: 1 } : n));
      } catch { /* ignore */ }
    }
    if (notif.link) navigate(notif.link);
  };

  const handleMarkAllRead = async () => {
    try {
      await api.post('/api/notifications/read-all');
      setUnread(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: 1 })));
    } catch { /* ignore */ }
  };

  const fetchPrefs = async () => {
    try {
      const data = await api.get('/api/notifications/preferences');
      setPrefs(data.preferences);
    } catch { /* ignore */ }
  };

  const togglePref = async (key) => {
    const newVal = prefs[key] === 1 ? 0 : 1;
    const updated = { ...prefs, [key]: newVal };
    setPrefs(updated);
    try { await api.put('/api/notifications/preferences', updated); } catch { /* ignore */ }
  };

  const PREF_LABELS = {
    email_ocr_complete: 'OCR complete',
    email_project_shared: 'Project shared',
    email_comment_reply: 'Comment replies',
    email_comment_mention: '@mentions',
  };

  const groups = groupByDate(notifications);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl text-cail-dark">Notifications</h1>
          {unread > 0 && (
            <p className="text-sm text-gray-500 mt-1">{unread} unread</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {unread > 0 && (
            <button
              onClick={handleMarkAllRead}
              className="text-sm text-cail-blue hover:text-cail-navy font-medium transition-colors"
            >
              Mark all read
            </button>
          )}
          <button
            onClick={() => { setPrefsOpen(!prefsOpen); if (!prefsOpen) fetchPrefs(); }}
            className={`p-2 rounded-xl transition-colors ${prefsOpen ? 'bg-cail-blue/10 text-cail-blue' : 'text-gray-500 hover:text-gray-600 hover:bg-gray-100'}`}
            title="Email preferences"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Email preferences panel */}
      {prefsOpen && prefs && (
        <div className="mb-8 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h3 className="font-display font-semibold text-sm text-cail-dark mb-4">Email notifications</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            {Object.entries(PREF_LABELS).map(([key, label]) => {
              const meta = TYPE_META[key.replace('email_', '')] || FALLBACK_META;
              return (
                <label key={key} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors">
                  <div className="flex items-center gap-2.5">
                    <span className={meta.color}>{meta.icon}</span>
                    <span className="text-sm text-gray-700">{label}</span>
                  </div>
                  <button
                    onClick={() => togglePref(key)}
                    className={`relative w-10 h-[22px] rounded-full transition-colors ${prefs[key] === 1 ? 'bg-cail-blue' : 'bg-gray-300'}`}
                  >
                    <span className={`absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow transition-transform ${prefs[key] === 1 ? 'translate-x-[18px]' : 'translate-x-0'}`} />
                  </button>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1 w-fit">
        {[['all', 'All'], ['unread', 'Unread']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              filter === key
                ? 'bg-white text-cail-dark shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
            {key === 'unread' && unread > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold">
                {unread}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Notification list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-cail-blue border-t-transparent" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-20">
          <svg className="w-12 h-12 text-gray-200 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          <p className="text-sm text-gray-500">
            {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <div key={group.label}>
              <h3 className="font-display text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3 px-1">
                {group.label}
              </h3>
              <div className="space-y-1.5">
                {group.items.map((notif) => {
                  const meta = TYPE_META[notif.type] || FALLBACK_META;
                  return (
                    <button
                      key={notif.id}
                      onClick={() => handleClick(notif)}
                      className={`w-full text-left flex items-start gap-3.5 p-4 rounded-2xl transition-all duration-200 group ${
                        !notif.read
                          ? 'bg-white border border-cail-blue/15 shadow-sm hover:shadow-md hover:-translate-y-px'
                          : 'bg-white/60 border border-transparent hover:bg-white hover:border-gray-100 hover:shadow-sm'
                      }`}
                    >
                      <div className={`mt-0.5 shrink-0 w-8 h-8 rounded-xl ${meta.bg} ${meta.color} flex items-center justify-center`}>
                        {meta.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-3">
                          <p className={`text-sm leading-snug ${!notif.read ? 'font-semibold text-cail-dark' : 'font-medium text-gray-700'}`}>
                            {notif.title}
                          </p>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[11px] text-gray-500">{timeAgo(notif.created_at)}</span>
                            {!notif.read && (
                              <span className="w-2 h-2 rounded-full bg-cail-blue shrink-0" />
                            )}
                          </div>
                        </div>
                        <p className={`text-sm mt-1 leading-relaxed ${!notif.read ? 'text-gray-600' : 'text-gray-500'}`}>
                          {notif.body}
                        </p>
                        <span className={`inline-block mt-2 text-[10px] font-semibold uppercase tracking-wider ${meta.color} opacity-60`}>
                          {meta.label}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
