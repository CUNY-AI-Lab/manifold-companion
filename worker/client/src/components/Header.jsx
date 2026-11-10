import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';

/** The notification menu: unread count on the button; the latest ten in a panel; open one to go there and mark it read. */
function Bell() {
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const button = useRef(null);
  const panel = useRef(null);
  const poll = useCallback(() => api.get('/api/notifications/unread-count').then((r) => setUnread(r.unread), () => {}), []);
  useEffect(() => {
    poll();
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !api.navigating) poll(); }, 60_000);
    return () => clearInterval(t);
  }, [poll]);
  useEffect(() => {
    if (!open) return undefined;
    api.get('/api/notifications?all=1&limit=10').then((r) => { setItems(r.notifications); setUnread(r.unread); }, () => setItems([]));
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    const onClick = (e) => { if (!panel.current?.contains(e.target) && !button.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [open]);
  const go = async (n) => {
    setOpen(false);
    if (!n.read) { try { await api.post(`/api/notifications/${n.id}/read`, {}); } catch { /* still navigate */ } poll(); }
    if (n.link && n.link.startsWith('/')) navigate(n.link);
  };
  return (
    <div className="relative">
      <button ref={button} type="button" className="text-sm text-slate-700 hover:text-cail-link dark:text-slate-200 dark:hover:text-cail-link-dark" aria-expanded={open} aria-controls="notification-menu" onClick={() => setOpen((o) => !o)}>
        Notifications
        {/* The visible count is part of the accessible name (WCAG 2.5.3, label in name). */}
        {unread > 0 ? <>{' '}<span className="ml-1 rounded-full bg-cail-link px-1.5 text-xs text-white">{unread}<span className="sr-only"> unread</span></span></> : null}
      </button>
      {open ? (
        <div ref={panel} id="notification-menu" role="region" aria-label="Recent notifications" className="absolute right-0 z-40 mt-2 w-80 max-w-[90vw] rounded-md border border-slate-200 bg-white p-2 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-800">
          {items === null ? <p role="status" className="p-2">Loading notifications</p> : null}
          {items?.length === 0 ? <p className="p-2 text-slate-600 dark:text-slate-300">No notifications yet.</p> : null}
          {items?.length ? (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={`block w-full rounded px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-700 ${n.read ? '' : 'font-semibold'}`} onClick={() => go(n)}>
                    {n.read ? null : <span className="sr-only">Unread: </span>}{n.title}
                    <span className="block text-xs font-normal text-slate-600 dark:text-slate-300">{n.created_at.slice(0, 16).replace('T', ' ')} UTC</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-1 flex justify-between border-t border-slate-200 px-2 pt-2 dark:border-slate-700">
            <button type="button" className="underline" disabled={unread === 0} onClick={async () => { await api.post('/api/notifications/read-all', {}); setItems((xs) => xs?.map((n) => ({ ...n, read: true })) ?? xs); setUnread(0); }}>Mark all read</button>
            <Link to="/notifications" onClick={() => setOpen(false)}>All notifications</Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Header() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
        <Link to="/" className="font-semibold text-cail-navy no-underline dark:text-slate-100">Manifold Companion</Link>
        <form role="search" className="ml-auto" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}>
          <label className="sr-only" htmlFor="site-search">Search your texts</label>
          <input id="site-search" className="field w-56" placeholder="Search your texts" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <nav className="flex items-center gap-4">
          <NavLink to="/help" className="text-sm text-slate-700 hover:text-cail-link dark:hover:text-cail-link-dark dark:text-slate-200">Help</NavLink>
          <Bell />
          <NavLink to="/settings" className="text-sm text-slate-700 hover:text-cail-link dark:hover:text-cail-link-dark dark:text-slate-200">{session?.profile?.display_name || 'Settings'}</NavLink>
        </nav>
      </div>
    </header>
  );
}
