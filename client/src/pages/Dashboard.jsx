import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import SearchBar from '../components/SearchBar';
import UsageBreakdown from '../components/UsageBreakdown';
import Skeleton from '../components/Skeleton';
import Pagination from '../components/Pagination';

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

const PAGE_LIMIT = 12;

export default function Dashboard() {
  const { user, updateProfile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [projects, setProjects] = useState([]);
  const [shared, setShared] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalShared, setTotalShared] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_LIMIT);
  const [sharedPageSize, setSharedPageSize] = useState(PAGE_LIMIT);
  const [storageUsed, setStorageUsed] = useState(0);
  const [tokenUsage, setTokenUsage] = useState(0);
  const [tokenAllowance, setTokenAllowance] = useState(5_000_000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Pagination — read initial values from URL
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('page')) || 1));
  const [sharedPage, setSharedPage] = useState(() => Math.max(1, Number(searchParams.get('sharedPage')) || 1));

  // New project form
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newProjectType, setNewProjectType] = useState('image_to_markdown');
  const [creating, setCreating] = useState(false);
  const [usageModal, setUsageModal] = useState(null);
  const [showWelcome, setShowWelcome] = useState(user?.onboarded === 0);

  // Sync page state to URL
  useEffect(() => {
    const params = {};
    if (page > 1) params.page = String(page);
    if (sharedPage > 1) params.sharedPage = String(sharedPage);
    setSearchParams(params, { replace: true });
  }, [page, sharedPage]);

  useEffect(() => {
    loadProjects();
  }, [page, sharedPage]);

  async function loadProjects() {
    try {
      const data = await api.get(
        `/api/projects?page=${page}&limit=${PAGE_LIMIT}&sharedPage=${sharedPage}&sharedLimit=${PAGE_LIMIT}`
      );
      setProjects(data.projects || []);
      setShared(data.shared || []);
      setTotal(data.total ?? (data.projects || []).length);
      setTotalShared(data.totalShared ?? (data.shared || []).length);
      setPageSize(data.pageSize ?? PAGE_LIMIT);
      setSharedPageSize(data.sharedPageSize ?? PAGE_LIMIT);
      setStorageUsed(data.storage_used_bytes || 0);
      setTokenUsage(data.token_usage || 0);
      setTokenAllowance(data.token_allowance || 5_000_000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handlePageChange(newPage) {
    setPage(newPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleSharedPageChange(newPage) {
    setSharedPage(newPage);
  }

  async function dismissWelcome() {
    setShowWelcome(false);
    try { await updateProfile({ onboarded: true }); } catch { /* ignore */ }
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

      {/* Welcome banner for new users */}
      {showWelcome && (
        <div className="mb-6 relative overflow-hidden rounded-2xl bg-gradient-to-r from-cail-blue/10 to-cail-teal/10 dark:from-cail-blue/20 dark:to-cail-teal/20 border border-cail-blue/20 dark:border-cail-blue/30 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200 mb-1">
                Welcome to Manifold Companion!
              </h3>
              <p className="text-sm text-gray-600 dark:text-slate-400">
                Your account is ready. Create a project to get started with document processing.
              </p>
            </div>
            <button
              onClick={dismissWelcome}
              className="shrink-0 p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-white/50 dark:hover:bg-slate-700/50 transition-colors"
              aria-label="Dismiss welcome banner"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

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
      {!loading && projects.length === 0 && shared.length === 0 && (
        <div className="py-12">
          <h3 className="font-display font-semibold text-xl text-center text-cail-dark dark:text-slate-200 mb-2">Get Started</h3>
          <p className="text-sm text-center text-gray-500 dark:text-slate-400 mb-8">Choose a workflow to create your first project.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto">
            {/* Image to Markdown */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 hover:shadow-lg hover:-translate-y-0.5 transition-all">
              <div className="w-12 h-12 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <h4 className="font-display font-semibold text-cail-dark dark:text-slate-200 mb-2">Image to Markdown</h4>
              <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">Upload scanned pages or photos. OCR extracts text as Markdown for editing and Manifold export.</p>
              <button
                onClick={() => { setNewProjectType('image_to_markdown'); setShowForm(true); }}
                className="w-full px-4 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-sm font-medium hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors border border-amber-200 dark:border-amber-800"
              >
                Create Project
              </button>
            </div>
            {/* PDF to HTML */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 hover:shadow-lg hover:-translate-y-0.5 transition-all">
              <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <h4 className="font-display font-semibold text-cail-dark dark:text-slate-200 mb-2">PDF to HTML</h4>
              <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">Upload a PDF document. AI parses each page into structured, editable HTML.</p>
              <button
                onClick={() => { setNewProjectType('pdf_to_html'); setShowForm(true); }}
                className="w-full px-4 py-2 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 text-sm font-medium hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors border border-blue-200 dark:border-blue-800"
              >
                Create Project
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project grid */}
      {!loading && projects.length > 0 && (
        <>
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
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
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
                      <span className={`text-xs ${days <= 7 ? 'text-red-500' : 'text-gray-400 dark:text-slate-500'}`}>
                        {days} day{days !== 1 ? 's' : ''} left
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
          <Pagination
            currentPage={page}
            totalPages={Math.ceil(total / pageSize)}
            onPageChange={handlePageChange}
            totalItems={total}
            pageSize={pageSize}
          />
        </>
      )}
      {/* Shared with You */}
      {(shared.length > 0 || totalShared > 0) && (
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
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
                  }`}>
                    {project.share_role === 'editor' ? 'Editor' : 'Viewer'}
                  </span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    project.project_type === 'pdf_to_html'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
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
          <Pagination
            currentPage={sharedPage}
            totalPages={Math.ceil(totalShared / sharedPageSize)}
            onPageChange={handleSharedPageChange}
            totalItems={totalShared}
            pageSize={sharedPageSize}
          />
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
                <span className="text-sm text-gray-500 dark:text-slate-400">
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
                <span className="text-sm text-gray-500 dark:text-slate-400">
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
