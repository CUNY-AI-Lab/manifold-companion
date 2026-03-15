import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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

const TYPE_ICONS = {
  ocr_complete: (
    <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  account_approved: (
    <svg className="w-4 h-4 text-cail-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  project_shared: (
    <svg className="w-4 h-4 text-cail-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  comment_reply: (
    <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
    </svg>
  ),
  comment_mention: (
    <svg className="w-4 h-4 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9" />
    </svg>
  ),
};

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState(null);
  const dropdownRef = useRef(null);

  // Poll unread count every 30s
  const fetchUnread = useCallback(async () => {
    try {
      const data = await api.get('/api/notifications/unread-count');
      setUnread(data.unread);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => clearInterval(interval);
  }, [fetchUnread]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
        setPrefsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const fetchNotifications = async () => {
    try {
      const data = await api.get('/api/notifications');
      setNotifications(data.notifications);
      setUnread(data.unread);
    } catch { /* ignore */ }
  };

  const handleOpen = () => {
    if (!open) {
      fetchNotifications();
      setPrefsOpen(false);
    }
    setOpen(!open);
  };

  const handleClick = async (notif) => {
    if (!notif.read) {
      try {
        await api.post(`/api/notifications/${notif.id}/read`);
        setUnread((u) => Math.max(0, u - 1));
        setNotifications((prev) => prev.map((n) => n.id === notif.id ? { ...n, read: 1 } : n));
      } catch { /* ignore */ }
    }
    setOpen(false);
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
    try {
      await api.put('/api/notifications/preferences', updated);
    } catch { /* ignore */ }
  };

  const openPrefs = () => {
    setPrefsOpen(true);
    fetchPrefs();
  };

  const PREF_LABELS = {
    email_ocr_complete: 'OCR complete',
    email_project_shared: 'Project shared',
    email_comment_reply: 'Comment replies',
    email_comment_mention: '@mentions',
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <button
        onClick={handleOpen}
        className="relative p-2 rounded-full text-gray-500 hover:text-cail-dark hover:bg-gray-100 transition-colors"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold px-1 ring-2 ring-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-xl border border-gray-200/80 overflow-hidden z-50 animate-in fade-in slide-in-from-top-1 duration-150">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h3 className="font-display font-semibold text-sm text-cail-dark">Notifications</h3>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  className="text-xs text-cail-blue hover:text-cail-navy font-medium transition-colors"
                >
                  Mark all read
                </button>
              )}
              <button
                onClick={prefsOpen ? () => setPrefsOpen(false) : openPrefs}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                title="Email preferences"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Preferences panel */}
          {prefsOpen && prefs && (
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Email notifications</p>
              <div className="space-y-2">
                {Object.entries(PREF_LABELS).map(([key, label]) => (
                  <label key={key} className="flex items-center justify-between cursor-pointer group">
                    <span className="text-sm text-gray-700 group-hover:text-cail-dark">{label}</span>
                    <button
                      onClick={() => togglePref(key)}
                      className={`relative w-9 h-5 rounded-full transition-colors ${prefs[key] === 1 ? 'bg-cail-blue' : 'bg-gray-300'}`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${prefs[key] === 1 ? 'translate-x-4' : 'translate-x-0'}`}
                      />
                    </button>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                No notifications yet
              </div>
            ) : (
              notifications.map((notif) => (
                <button
                  key={notif.id}
                  onClick={() => handleClick(notif)}
                  className={`w-full text-left px-4 py-3 flex gap-3 hover:bg-gray-50 transition-colors ${!notif.read ? 'bg-cail-blue/[0.03]' : ''}`}
                >
                  <div className="mt-0.5 shrink-0">
                    {TYPE_ICONS[notif.type] || (
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm leading-snug ${!notif.read ? 'font-medium text-cail-dark' : 'text-gray-700'}`}>
                      {notif.title}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{notif.body}</p>
                    <p className="text-[11px] text-gray-300 mt-1">{timeAgo(notif.created_at)}</p>
                  </div>
                  {!notif.read && (
                    <span className="mt-1.5 w-2 h-2 rounded-full bg-cail-blue shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>

          {/* See all link */}
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-center text-xs font-medium text-cail-blue hover:text-cail-navy hover:bg-gray-50 border-t border-gray-100 transition-colors"
          >
            See all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
