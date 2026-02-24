import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
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

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt) - new Date();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 0;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [storageUsed, setStorageUsed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // New project form
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    try {
      const data = await api.get('/api/projects');
      setProjects(data.projects || []);
      setStorageUsed(data.storage_used_bytes || 0);
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
      await api.post('/api/projects', { name: newName.trim(), description: newDesc.trim() });
      setNewName('');
      setNewDesc('');
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
          <h1 className="font-display font-semibold text-2xl text-cail-dark">Your Projects</h1>
          <p className="text-sm text-gray-500 mt-1">
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

      {/* Storage bar */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-600">Storage Usage</span>
          <span className="text-sm text-gray-500">
            {formatBytes(usedStorage)} / {formatBytes(totalStorage)}
          </span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${storagePercent > 80 ? 'bg-red-500' : 'bg-cail-teal'}`}
            style={{ width: `${storagePercent}%` }}
          />
        </div>
      </div>

      {/* 90-day expiry notice for regular users */}
      {!isAdmin && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6 flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-amber-800">
            Projects are automatically deleted 90 days after creation. Please export your work before the expiry date shown on each project.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* New project form */}
      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6 shadow-sm">
          <h2 className="font-display font-semibold text-lg text-cail-dark mb-4">Create New Project</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label htmlFor="project-name" className="block text-sm font-medium text-gray-700 mb-1">
                Project Name
              </label>
              <input
                id="project-name"
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm"
                placeholder="My OCR Project"
              />
            </div>
            <div>
              <label htmlFor="project-desc" className="block text-sm font-medium text-gray-700 mb-1">
                Description (optional)
              </label>
              <textarea
                id="project-desc"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                rows={2}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm resize-none"
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
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
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
          <h3 className="font-display font-semibold text-lg text-cail-dark mb-1">No projects yet</h3>
          <p className="text-sm text-gray-500">Create your first project to get started with OCR.</p>
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
                className="bg-white rounded-2xl border border-gray-100 p-6 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200 group"
              >
                <h3 className="font-display font-semibold text-lg text-cail-dark group-hover:text-cail-blue transition-colors mb-2">
                  {project.name}
                </h3>
                {project.description && (
                  <p className="text-sm text-gray-500 mb-4 line-clamp-2">{project.description}</p>
                )}
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-cail-blue/10 text-cail-blue">
                    {project.text_count || 0} text{(project.text_count || 0) !== 1 ? 's' : ''}
                  </span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
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
    </div>
  );
}
