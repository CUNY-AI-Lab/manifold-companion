import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatTokens(tokens) {
  if (!tokens) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function BarRow({ label, value, formattedValue, max, color, suffix }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm text-gray-700 truncate mr-3">{label}</span>
        <span className="text-xs text-gray-500 shrink-0">
          {formattedValue}{suffix ? ` (${suffix})` : ''}
        </span>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${Math.max((value / max) * 100, 2)}%` }}
        />
      </div>
    </div>
  );
}

export default function UsageBreakdown({ type, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/projects/usage')
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const maxStorage = data?.storage?.reduce((max, p) => Math.max(max, p.bytes), 0) || 1;
  const maxTokens = data?.tokensByProject?.reduce((max, p) => Math.max(max, p.tokens), 0) || 1;
  const maxEndpoint = data?.tokensByEndpoint?.reduce((max, e) => Math.max(max, e.tokens), 0) || 1;

  const totalStorageBytes = data?.storage?.reduce((sum, p) => sum + p.bytes, 0) || 0;
  const totalTokens = data?.tokensByProject?.reduce((sum, p) => sum + p.tokens, 0) || 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col animate-in fade-in duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="font-display font-semibold text-lg text-cail-dark">
              {type === 'storage' ? 'Storage Breakdown' : 'Token Usage Breakdown'}
            </h2>
            {!loading && data && (
              <p className="text-xs text-gray-400 mt-0.5">
                {type === 'storage'
                  ? `${formatBytes(totalStorageBytes)} total across ${data.storage.length} project${data.storage.length !== 1 ? 's' : ''}`
                  : `${formatTokens(totalTokens)} tokens used`
                }
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-6">
          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-cail-blue border-t-transparent" />
            </div>
          ) : type === 'storage' ? (
            <>
              {(!data?.storage || data.storage.length === 0) ? (
                <p className="text-sm text-gray-400 text-center py-8">No storage used yet.</p>
              ) : (
                <div className="space-y-3">
                  {data.storage
                    .sort((a, b) => b.bytes - a.bytes)
                    .map((p) => (
                      <BarRow
                        key={p.id}
                        label={p.name}
                        value={p.bytes}
                        formattedValue={formatBytes(p.bytes)}
                        max={maxStorage}
                        color="bg-cail-teal"
                      />
                    ))}
                </div>
              )}
            </>
          ) : (
            <>
              {/* By Project */}
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">By Project</h3>
              {(!data?.tokensByProject || data.tokensByProject.length === 0) ? (
                <p className="text-sm text-gray-400 text-center py-4">No token usage yet.</p>
              ) : (
                <div className="space-y-3 mb-8">
                  {data.tokensByProject.map((p) => (
                    <BarRow
                      key={p.project_id}
                      label={p.project_name || 'Unknown'}
                      value={p.tokens}
                      formattedValue={formatTokens(p.tokens)}
                      suffix={`${p.calls} call${p.calls !== 1 ? 's' : ''}`}
                      max={maxTokens}
                      color="bg-cail-blue"
                    />
                  ))}
                </div>
              )}

              {/* By Endpoint */}
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">By Endpoint</h3>
              {(!data?.tokensByEndpoint || data.tokensByEndpoint.length === 0) ? (
                <p className="text-sm text-gray-400 text-center py-4">No token usage yet.</p>
              ) : (
                <div className="space-y-3">
                  {data.tokensByEndpoint.map((ep) => (
                    <BarRow
                      key={ep.endpoint}
                      label={ep.endpoint}
                      value={ep.tokens}
                      formattedValue={formatTokens(ep.tokens)}
                      suffix={`${ep.calls} call${ep.calls !== 1 ? 's' : ''}`}
                      max={maxEndpoint}
                      color="bg-violet-400"
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
