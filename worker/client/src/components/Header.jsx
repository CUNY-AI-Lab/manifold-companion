import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';

function Bell() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let live = true;
    const poll = () => api.get('/api/notifications/unread-count').then((r) => live && setUnread(r.unread), () => {});
    poll();
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !api.navigating) poll(); }, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return (
    <NavLink to="/notifications" className="relative text-sm text-slate-700 hover:text-cail-link dark:hover:text-cail-link-dark dark:text-slate-200" aria-label={`Notifications, ${unread} unread`}>
      Notifications
      {unread > 0 ? <span className="ml-1 rounded-full bg-cail-link px-1.5 text-xs text-white">{unread}</span> : null}
    </NavLink>
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
