import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import SearchBar from '../components/SearchBar';
import UsageBreakdown from '../components/UsageBreakdown';
import Skeleton from '../components/Skeleton';

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

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt) - new Date();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 0;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [shared, setShared] = useState([]);
  const [storageUsed, setStorageUsed] = useState(0);
  const [tokenUsage, setTokenUsage] = useState(0);
  const [tokenAllowance, setTokenAllowance] = useState(5_000_000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // New project form
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newProjectType, setNewProjectType] = useState('image_to_markdown');
  const [creating, setCreating] = useState(false);
  const [usageModal, setUsageModal] = useState(null);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    try {
      const data = await api.get('/api/projects');
      setProjects(data.projects || []);
      setShared(data.shared || []);
      setStorageUsed(data.storage_used_bytes || 0);
      setTokenUsage(data.token_usage || 0);
      setTokenAllowance(data.token_allowance || 5_000_000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError('');
    try {
      await api.post('/api/projects', {
        name: newName.trim(),
        description: newDesc.trim(),
        project_type: newProjectType,
      });
      setNewName('');
      setNewDesc('');
      setNewProjectType('image_to_markdown');
      setShowForm(false);
      await loadProjects();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  // Calculate storage usage
  const isAdmin = user?.role === 'admin';
  const totalStorage = isAdmin ? 500 * 1024 * 1024 : 50 * 1024 * 1024;
  const usedStorage = storageUsed;
  const storagePercent = Math.min((usedStorage / totalStorage) * 100, 100);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Hero area */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display font-semibold text-2xl text-cail-dark dark:text-slate-200">Your Projects</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Manage your OCR projects and texts
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-6 py-2.5 rounded-full bg-cail-blue text-white font-medium text-sm hover:bg-cail-navy transition-colors hover:shadow-lg hover:-translate-y-0.5 transform"
        >
          {showForm ? 'Cancel' : 'New Project'}
        </button>
      </div>

      {/* Search */}
      <div className="mb-6">
        <SearchBar compact={false} />
      </div>

      {/* 90-day expiry notice for regular users */}
      {!isAdmin && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 mb-6 flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Projects are automatically deleted 90 days after creation. Please export your work before the expiry date shown on each project.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* New project form */}
      {showForm && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6 mb-6 shadow-sm">
          <h2 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200 mb-4">Create New Project</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label htmlFor="project-name" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
                Project Name
              </label>
              <input
                id="project-name"
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm"
                placeholder="My OCR Project"
              />
            </div>
            <div>
              <label htmlFor="project-type" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
                Project Type
              </label>
              <select
                id="project-type"
                value={newProjectType}
                onChange={(e) => setNewProjectType(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm bg-white"
              >
                <option value="image_to_markdown">Image to Markdown</option>
                <option value="pdf_to_html">PDF to HTML</option>
              </select>
            </div>
            <div>
              <label htmlFor="project-desc" className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">
                Description (optional)
              </label>
              <textarea
                id="project-desc"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                rows={2}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm resize-none"
                placeholder="Brief description of this project"
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="px-6 py-2.5 rounded-full bg-cail-blue text-white font-medium text-sm hover:bg-cail-navy transition-colors disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Project'}
            </button>
          </form>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 6 }, (_, i) => <Skeleton.Card key={i} />)}
        </div>
      )}

      {/* Empty state */}
      {!loading && projects.length === 0 && (
        <div className="text-center py-16">
          <button
            onClick={() => setShowForm(true)}
            className="mx-auto w-16 h-16 rounded-2xl bg-cail-blue/10 flex items-center justify-center mb-4 hover:bg-cail-blue/20 transition-colors cursor-pointer"
          >
            <svg className="w-8 h-8 text-cail-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </button>
          <h3 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200 mb-1">No projects yet</h3>
          <p className="text-sm text-gray-500 dark:text-slate-400">Create your first project to get started with OCR.</p>
        </div>
      )}

      {/* Project grid */}
      {!loading && projects.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map((project) => {
            const days = daysRemaining(project.expires_at);
            return (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 group"
              >
                <h3 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200 group-hover:text-cail-blue transition-colors mb-2">
                  {project.name}
                </h3>
                {project.description && (
                  <p className="text-sm text-gray-500 dark:text-slate-400 mb-4 line-clamp-2">{project.description}</p>
                )}
                <div className="flex items-center gap-3 flex-wrap">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    project.project_type === 'pdf_to_html'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-cail-blue/10 text-cail-blue'
                  }`}>
                    {project.project_type === 'pdf_to_html' ? 'PDF to HTML' : 'Image to Markdown'}
                  </span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-cail-blue/10 text-cail-blue">
                    {project.text_count || 0} text{(project.text_count || 0) !== 1 ? 's' : ''}
                  </span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300">
                    {project.page_count || 0} page{(project.page_count || 0) !== 1 ? 's' : ''}
                  </span>
                  {days !== null && (
                    <span className={`text-xs ${days <= 7 ? 'text-red-500' : 'text-gray-400'}`}>
                      {days} day{days !== 1 ? 's' : ''} left
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {/* Shared with You */}
      {shared.length > 0 && (
        <>
          <div className="mt-12 mb-6">
            <h2 className="font-display font-semibold text-xl text-cail-dark dark:text-slate-200">Shared with You</h2>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Projects other users have shared with you</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {shared.map((project) => (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 group"
              >
                <h3 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200 group-hover:text-cail-blue transition-colors mb-1">
                  {project.name}
                </h3>
                <p className="text-xs text-gray-400 dark:text-slate-500 mb-3">{project.owner_email}</p>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    project.share_role === 'editor'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
                  }`}>
                    {project.share_role === 'editor' ? 'Editor' : 'Viewer'}
                  </span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    project.project_type === 'pdf_to_html'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-cail-blue/10 text-cail-blue'
                  }`}>
                    {project.project_type === 'pdf_to_html' ? 'PDF to HTML' : 'Image to Markdown'}
                  </span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-cail-blue/10 text-cail-blue">
                    {project.text_count || 0} text{(project.text_count || 0) !== 1 ? 's' : ''}
                  </span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300">
                    {project.page_count || 0} page{(project.page_count || 0) !== 1 ? 's' : ''}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
      {/* Usage bars */}
      {!loading && (
        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-4">
            <div
              onClick={() => setUsageModal('storage')}
              className="cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600 dark:text-slate-400 group-hover:text-cail-teal transition-colors">Storage</span>
                <span className="text-sm text-gray-500">
                  {formatBytes(usedStorage)} / {formatBytes(totalStorage)}
                </span>
              </div>
              <div className="w-full bg-gray-100 dark:bg-slate-700 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${storagePercent > 80 ? 'bg-red-500' : 'bg-cail-teal'}`}
                  style={{ width: `${storagePercent}%` }}
                />
              </div>
            </div>
            <a
              href={`mailto:ailab@gc.cuny.edu?subject=${encodeURIComponent('Manifold Companion — Storage Increase Request')}&body=${encodeURIComponent(`Hi CUNY AI Lab,\n\nI'd like to request additional storage for my Manifold Companion account.\n\nAccount email: ${user?.email || ''}\nCurrent usage: ${formatBytes(usedStorage)} / ${formatBytes(totalStorage)}\n\nRequested storage amount: \nReason: \nProject(s) this is for: \n\nThank you!`)}`}
              className="inline-block mt-2 text-xs text-cail-blue hover:text-cail-navy font-medium transition-colors"
            >
              Request more storage
            </a>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-4">
            <div
              onClick={() => setUsageModal('tokens')}
              className="cursor-pointer group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600 dark:text-slate-400 group-hover:text-cail-blue transition-colors">Token Usage</span>
                <span className="text-sm text-gray-500">
                  {formatTokens(tokenUsage)} / {formatTokens(tokenAllowance)}
                </span>
              </div>
              <div className="w-full bg-gray-100 dark:bg-slate-700 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${tokenAllowance > 0 && (tokenUsage / tokenAllowance) > 0.8 ? 'bg-red-500' : 'bg-cail-blue'}`}
                  style={{ width: `${tokenAllowance > 0 ? Math.min((tokenUsage / tokenAllowance) * 100, 100) : 0}%` }}
                />
              </div>
            </div>
            <a
              href={`mailto:ailab@gc.cuny.edu?subject=${encodeURIComponent('Manifold Companion — Token Increase Request')}&body=${encodeURIComponent(`Hi CUNY AI Lab,\n\nI'd like to request additional tokens for my Manifold Companion account.\n\nAccount email: ${user?.email || ''}\nCurrent usage: ${formatTokens(tokenUsage)} / ${formatTokens(tokenAllowance)}\n\nRequested token amount: \nReason: \nExpected use (e.g., OCR pages, translations): \n\nThank you!`)}`}
              className="inline-block mt-2 text-xs text-cail-blue hover:text-cail-navy font-medium transition-colors"
            >
              Request more tokens
            </a>
          </div>
        </div>
      )}

      {usageModal && <UsageBreakdown type={usageModal} onClose={() => setUsageModal(null)} />}
    </div>
  );
}
