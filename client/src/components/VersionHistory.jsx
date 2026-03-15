import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';

function formatTimestamp(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function VersionHistory({ textId, contentType, open, onClose, onRevert }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reverting, setReverting] = useState(false);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/api/texts/${textId}/versions?type=${contentType}`);
      setVersions(data.versions || data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [textId, contentType]);

  useEffect(() => {
    if (open) {
      fetchVersions();
      setPreviewId(null);
      setPreviewContent('');
    }
  }, [open, fetchVersions]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  async function handlePreview(versionId) {
    if (previewId === versionId) {
      setPreviewId(null);
      setPreviewContent('');
      return;
    }
    setPreviewId(versionId);
    setPreviewLoading(true);
    try {
      const data = await api.get(`/api/texts/${textId}/versions/${versionId}`);
      setPreviewContent(data.content || '');
    } catch (err) {
      setPreviewContent(`Error loading preview: ${err.message}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleRevert(versionId) {
    if (!window.confirm('Revert to this version? Current content will be saved as a version first.')) {
      return;
    }
    setReverting(true);
    try {
      await api.post(`/api/texts/${textId}/versions/${versionId}/revert`);
      onRevert?.();
      onClose();
    } catch (err) {
      alert(`Revert failed: ${err.message}`);
    } finally {
      setReverting(false);
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Panel */}
      <div className="relative w-full max-w-xl bg-white shadow-2xl rounded-l-2xl flex flex-col animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-display font-semibold text-cail-navy">
            Version History
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-cail-dark transition-colors text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-cail-blue border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <p className="text-red-600 text-sm py-4">{error}</p>
          )}

          {!loading && !error && versions.length === 0 && (
            <p className="text-gray-500 text-sm py-12 text-center">
              No saved versions yet.
            </p>
          )}

          {!loading && versions.length > 0 && (
            <ul className="space-y-3">
              {versions.map((v) => (
                <li key={v.id} className="border border-gray-200 rounded-2xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-cail-dark truncate">
                        {formatTimestamp(v.created_at)}
                      </p>
                      {v.email && (
                        <p className="text-xs text-gray-500 truncate">{v.email}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      <button
                        onClick={() => handlePreview(v.id)}
                        className="px-3 py-1 text-xs font-medium rounded-lg border border-cail-blue text-cail-blue hover:bg-cail-blue/10 transition-colors"
                      >
                        {previewId === v.id ? 'Hide' : 'Preview'}
                      </button>
                      <button
                        onClick={() => handleRevert(v.id)}
                        disabled={reverting}
                        className="px-3 py-1 text-xs font-medium rounded-lg bg-cail-blue text-white hover:bg-cail-navy transition-colors disabled:opacity-50"
                      >
                        Revert
                      </button>
                    </div>
                  </div>

                  {previewId === v.id && (
                    <div className="border-t border-gray-200 bg-gray-50 px-4 py-3">
                      {previewLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <div className="w-4 h-4 border-2 border-cail-blue border-t-transparent rounded-full animate-spin" />
                        </div>
                      ) : (
                        <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono">
                          {previewContent}
                        </pre>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
