import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorNote, formatBytes } from './ui';

/** Which projects you own use your storage, largest first, each as a share of your allowance. */
export default function StorageBreakdown() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/api/usage/storage').then(setData, setError); }, []);
  if (error) return <ErrorNote error={error} onDismiss={() => setError(null)} />;
  if (!data) return <p role="status">Loading what uses your storage</p>;
  if (data.projects.length === 0) return <p>You own no projects, so nothing uses your storage.</p>;
  const pct = (b) => (data.quota_bytes ? Math.round((b / data.quota_bytes) * 1000) / 10 : 0);
  return (
    <table className="mt-1 w-full max-w-xl text-left text-sm">
      <caption className="sr-only">Storage by project, largest first</caption>
      <thead><tr className="text-xs text-slate-600 dark:text-slate-300"><th scope="col" className="py-1 font-medium">Project</th><th scope="col" className="py-1 text-right font-medium">Stored</th><th scope="col" className="py-1 pl-3 font-medium">Share of your {formatBytes(data.quota_bytes)}</th></tr></thead>
      <tbody>
        {data.projects.map((p) => (
          <tr key={p.id} className="border-t border-slate-200 dark:border-slate-700">
            <td className="py-1"><Link to={`/projects/${p.id}`}>{p.name}</Link></td>
            <td className="py-1 text-right tabular-nums">{formatBytes(p.bytes)}</td>
            <td className="py-1 pl-3">
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="h-2 w-28 rounded bg-slate-200 dark:bg-slate-700"><span className="block h-2 rounded bg-cail-teal" style={{ width: `${Math.min(100, pct(p.bytes))}%` }} /></span>
                <span className="tabular-nums">{pct(p.bytes)}%</span>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
