import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorNote, Spinner } from '../components/ui';

export default function NotificationsPage() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/api/notifications?all=1&limit=200').then((r) => setItems(r.notifications), setError), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between"><h1 className="text-2xl">Notifications</h1><button className="btn-quiet" type="button" onClick={async () => { await api.post('/api/notifications/read-all'); load(); }}>Mark all as read</button></div>
      <ErrorNote error={error} />
      {items === null ? <Spinner /> : (
        <ul className="rowlist mt-4 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
          {items.length === 0 ? <li className="p-4 text-sm text-slate-500 dark:text-slate-400">Nothing yet. Replies, mentions, new members and deletion warnings appear here.</li> : null}
          {items.map((n) => (
            <li key={n.id} className={`p-4 ${n.read ? 'opacity-70' : ''} ${n.type === 'retention_warning' ? 'bg-amber-50 dark:bg-amber-950' : ''}`}>
              <p className="text-sm font-medium">{n.link ? <Link to={n.link} onClick={() => !n.read && api.post(`/api/notifications/${n.id}/read`)}>{n.title}</Link> : n.title}</p>
              {n.body ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{n.body}</p> : null}
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{n.created_at.replace('T', ' ').slice(0, 16)} UTC{n.read ? '' : ', unread'}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
