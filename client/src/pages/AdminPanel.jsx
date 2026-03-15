import { useState, useEffect } from 'react';
import { api, BASE } from '../api/client';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatTokens(tokens) {
  if (!tokens) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatDate(dateStr) {
  if (!dateStr) return 'Never';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const STATUS_STYLES = {
  pending: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  approved: 'bg-green-50 text-green-700 border-green-200',
  disabled: 'bg-red-50 text-red-700 border-red-200',
};

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'usage', label: 'Usage' },
  { id: 'backups', label: 'Backups' },
];

// ---------------------------------------------------------------------------
// Users Tab
// ---------------------------------------------------------------------------

function UsersTab({ users, onRefresh, toast, setToast, error, setError }) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [newStatus, setNewStatus] = useState('approved');
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [editingAllowance, setEditingAllowance] = useState(null);
  const [allowanceValue, setAllowanceValue] = useState('');
  const [editingName, setEditingName] = useState(null);
  const [nameValue, setNameValue] = useState('');

  const pendingUsers = users.filter((u) => u.status === 'pending');
  const totalStorage = users.reduce((acc, u) => acc + (u.storage_used_bytes || 0), 0);

  async function updateStatus(userId, status) {
    try {
      await api.put(`/api/admin/users/${userId}/status`, { status });
      setToast(`User ${status === 'approved' ? 'approved' : 'disabled'}.`);
      setTimeout(() => setToast(''), 3000);
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    if (!newEmail.trim() || !newPassword) return;
    setCreating(true);
    setError('');
    try {
      await api.post('/api/admin/users', {
        email: newEmail.trim(),
        password: newPassword,
        role: newRole,
        status: newStatus,
        name: newName.trim() || undefined,
      });
      setNewEmail('');
      setNewPassword('');
      setNewName('');
      setNewRole('user');
      setNewStatus('approved');
      setShowCreateForm(false);
      setToast('User created successfully.');
      setTimeout(() => setToast(''), 3000);
      onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function deleteUser(userId) {
    try {
      await api.del(`/api/admin/users/${userId}`);
      setConfirmDelete(null);
      setToast('User deleted.');
      setTimeout(() => setToast(''), 3000);
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleBulkApprove() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      await api.put('/api/admin/users/bulk-status', { userIds: ids, status: 'approved' });
      setSelected(new Set());
      setToast(`${ids.length} user(s) approved.`);
      setTimeout(() => setToast(''), 3000);
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function selectAllPending() {
    setSelected(new Set(pendingUsers.map((u) => u.id)));
  }

  function toggleSelect(userId) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });
  }

  async function saveName(userId) {
    try {
      await api.put(`/api/admin/users/${userId}/name`, { name: nameValue.trim() });
      setEditingName(null);
      setToast('Display name updated.');
      setTimeout(() => setToast(''), 3000);
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveAllowance(userId) {
    const val = Number(allowanceValue);
    if (!Number.isFinite(val) || val < 0) return;
    try {
      await api.put(`/api/admin/users/${userId}/token-allowance`, { allowance: val });
      setEditingAllowance(null);
      setToast('Token allowance updated.');
      setTimeout(() => setToast(''), 3000);
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetUsage(userId) {
    try {
      await api.post(`/api/admin/users/${userId}/reset-usage`);
      setToast('Token usage reset.');
      setTimeout(() => setToast(''), 3000);
      onRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <>
              <span className="text-sm text-gray-500">{selected.size} selected</span>
              <button
                onClick={handleBulkApprove}
                className="px-4 py-1.5 rounded-full bg-green-500 text-white text-sm font-medium hover:bg-green-600 transition-colors"
              >
                Approve Selected
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="px-3 py-1.5 rounded-full text-sm text-gray-500 hover:bg-gray-100 transition-colors"
              >
                Clear
              </button>
            </>
          )}
          {pendingUsers.length > 0 && selected.size === 0 && (
            <button
              onClick={selectAllPending}
              className="px-4 py-1.5 rounded-full border border-yellow-300 text-yellow-700 text-sm font-medium hover:bg-yellow-50 transition-colors"
            >
              Select {pendingUsers.length} Pending
            </button>
          )}
        </div>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="px-6 py-2.5 rounded-full bg-cail-blue text-white font-medium text-sm hover:bg-cail-navy transition-colors"
        >
          {showCreateForm ? 'Cancel' : 'Create User'}
        </button>
      </div>

      {/* Create user form */}
      {showCreateForm && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6 shadow-sm">
          <h2 className="font-display font-semibold text-lg text-cail-dark mb-4">Create New User</h2>
          <form onSubmit={handleCreateUser} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={100}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm"
                  placeholder="Optional"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none transition text-sm"
                  placeholder="Min 8 characters"
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue outline-none text-sm"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select
                    value={newStatus}
                    onChange={(e) => setNewStatus(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 focus:border-cail-blue outline-none text-sm"
                  >
                    <option value="approved">Approved</option>
                    <option value="pending">Pending</option>
                  </select>
                </div>
              </div>
            </div>
            <button
              type="submit"
              disabled={creating}
              className="px-6 py-2.5 rounded-full bg-cail-blue text-white font-medium text-sm hover:bg-cail-navy transition-colors disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create User'}
            </button>
          </form>
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">Total Users</p>
          <p className="font-display font-semibold text-2xl text-cail-dark">{users.length}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">Pending Approvals</p>
          <p className="font-display font-semibold text-2xl text-yellow-600">{pendingUsers.length}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">Total Storage Used</p>
          <p className="font-display font-semibold text-2xl text-cail-dark">{formatBytes(totalStorage)}</p>
        </div>
      </div>

      {/* Users table */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === users.length}
                    onChange={() => {
                      if (selected.size === users.length) setSelected(new Set());
                      else setSelected(new Set(users.map((u) => u.id)));
                    }}
                    className="rounded border-gray-300"
                  />
                </th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">User</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Status</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Role</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Storage</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Tokens</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Projects</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Last Login</th>
                <th className="text-right text-xs font-medium text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {users.map((user) => (
                <tr key={user.id} className={`hover:bg-gray-50/50 transition-colors ${selected.has(user.id) ? 'bg-cail-blue/5' : ''}`}>
                  <td className="px-4 py-4">
                    <input
                      type="checkbox"
                      checked={selected.has(user.id)}
                      onChange={() => toggleSelect(user.id)}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-4">
                    {editingName === user.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={nameValue}
                          onChange={(e) => setNameValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveName(user.id); if (e.key === 'Escape') setEditingName(null); }}
                          placeholder="Display name"
                          className="w-40 px-2 py-1 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-cail-blue"
                          autoFocus
                        />
                        <button onClick={() => saveName(user.id)} className="text-xs text-cail-blue hover:underline">Save</button>
                        <button onClick={() => setEditingName(null)} className="text-xs text-gray-400 hover:underline">Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingName(user.id); setNameValue(user.display_name || ''); }}
                        className="text-left group"
                        title="Click to edit name"
                      >
                        {user.display_name ? (
                          <>
                            <p className="text-sm font-medium text-cail-dark group-hover:text-cail-blue transition-colors">{user.display_name}</p>
                            <p className="text-sm text-gray-400">{user.email}</p>
                          </>
                        ) : (
                          <>
                            <p className="text-sm text-cail-dark">{user.email}</p>
                            <p className="text-xs text-gray-300 group-hover:text-cail-blue transition-colors">+ add name</p>
                          </>
                        )}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[user.status] || 'bg-gray-50 text-gray-600'}`}>
                      {user.status}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-sm text-gray-600">{user.role}</td>
                  <td className="px-4 py-4 text-sm text-gray-600">{formatBytes(user.storage_used_bytes)}</td>
                  <td className="px-4 py-4">
                    {editingAllowance === user.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          value={allowanceValue}
                          onChange={(e) => setAllowanceValue(e.target.value)}
                          className="w-24 px-2 py-1 text-xs border border-gray-300 rounded-lg"
                          min="0"
                        />
                        <button onClick={() => saveAllowance(user.id)} className="text-xs text-cail-blue hover:underline">Save</button>
                        <button onClick={() => setEditingAllowance(null)} className="text-xs text-gray-400 hover:underline">Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingAllowance(user.id); setAllowanceValue(String(user.token_allowance)); }}
                        className="text-left hover:text-cail-blue transition-colors"
                        title="Click to edit allowance"
                      >
                        <span className={`text-sm font-medium ${user.token_allowance > 0 && (user.token_usage / user.token_allowance) > 0.8 ? 'text-red-600' : 'text-gray-600'}`}>
                          {formatTokens(user.token_usage)}
                        </span>
                        <span className="text-sm text-gray-400"> / {formatTokens(user.token_allowance)}</span>
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-4 text-sm text-gray-600">{user.project_count || 0}</td>
                  <td className="px-4 py-4 text-sm text-gray-400">{formatDate(user.last_login_at)}</td>
                  <td className="px-4 py-4">
                    <div className="flex items-center justify-end gap-1 flex-wrap">
                      {user.status === 'pending' && (
                        <button onClick={() => updateStatus(user.id, 'approved')} className="px-3 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100 transition-colors">Approve</button>
                      )}
                      {user.status === 'approved' && user.role !== 'admin' && (
                        <button onClick={() => updateStatus(user.id, 'disabled')} className="px-3 py-1 rounded-full bg-yellow-50 text-yellow-700 text-xs font-medium hover:bg-yellow-100 transition-colors">Disable</button>
                      )}
                      {user.status === 'disabled' && (
                        <button onClick={() => updateStatus(user.id, 'approved')} className="px-3 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100 transition-colors">Enable</button>
                      )}
                      <button onClick={() => resetUsage(user.id)} className="px-3 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-medium hover:bg-blue-100 transition-colors" title="Reset token usage counter">Reset Usage</button>
                      {user.role !== 'admin' && (
                        <button onClick={() => setConfirmDelete(user)} className="px-3 py-1 rounded-full bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {users.length === 0 && (
          <div className="text-center py-12">
            <p className="text-sm text-gray-500">No users found.</p>
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6">
            <h3 className="font-display font-semibold text-lg text-cail-dark mb-2">Delete User</h3>
            <p className="text-sm text-gray-600 mb-6">
              Are you sure you want to delete <strong>{confirmDelete.display_name || confirmDelete.email}</strong>? This will remove all their projects and data.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 rounded-full text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
              <button onClick={() => deleteUser(confirmDelete.id)} className="px-4 py-2 rounded-full bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">Delete User</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Usage Tab
// ---------------------------------------------------------------------------

function UsageTab() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    loadStats();
  }, [days]);

  async function loadStats() {
    setLoading(true);
    try {
      const data = await api.get(`/api/admin/usage?days=${days}`);
      setStats(data);
    } catch {
      setStats(null);
    }
    setLoading(false);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
      </div>
    );
  }

  if (!stats) {
    return <p className="text-center text-gray-500 py-8">Failed to load usage data.</p>;
  }

  return (
    <>
      {/* Period selector */}
      <div className="flex items-center gap-2 mb-6">
        <span className="text-sm text-gray-500">Period:</span>
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
              days === d ? 'bg-cail-blue text-white' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">API Calls ({days}d)</p>
          <p className="font-display font-semibold text-2xl text-cail-dark">{stats.totals?.total_calls?.toLocaleString() || 0}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">Tokens Consumed ({days}d)</p>
          <p className="font-display font-semibold text-2xl text-cail-dark">{formatTokens(stats.totals?.total_tokens)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">Active Users ({days}d)</p>
          <p className="font-display font-semibold text-2xl text-cail-dark">{stats.byUser?.length || 0}</p>
        </div>
      </div>

      {/* Endpoint breakdown */}
      {stats.byEndpoint?.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6">
          <h3 className="font-display font-semibold text-sm text-cail-dark mb-4">By Endpoint</h3>
          <div className="space-y-2">
            {stats.byEndpoint.map((ep) => (
              <div key={ep.endpoint} className="flex items-center justify-between">
                <span className="text-sm text-gray-600">{ep.endpoint}</span>
                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <span>{ep.calls} calls</span>
                  <span>{formatTokens(ep.tokens_in + ep.tokens_out)} tokens</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-user usage */}
      {stats.byUser?.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden mb-6">
          <h3 className="font-display font-semibold text-sm text-cail-dark px-6 py-4 border-b border-gray-100">Per-User Usage</h3>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-6 py-3">User</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-6 py-3">Calls</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-6 py-3">Tokens Used</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-6 py-3">Allowance</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-6 py-3">% Used</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-6 py-3">Storage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {stats.byUser.map((u) => {
                  const pct = u.token_allowance > 0 ? Math.round((u.current_usage / u.token_allowance) * 100) : 0;
                  const pctColor = pct > 90 ? 'text-red-600' : pct > 50 ? 'text-yellow-600' : 'text-green-600';
                  return (
                    <tr key={u.user_id} className="hover:bg-gray-50/50">
                      <td className="px-6 py-3">
                        <p className="text-sm text-cail-dark">{u.display_name || u.email}</p>
                        {u.display_name && <p className="text-xs text-gray-400">{u.email}</p>}
                      </td>
                      <td className="px-6 py-3 text-sm text-gray-600">{u.calls}</td>
                      <td className="px-6 py-3 text-sm text-gray-600">{formatTokens(u.current_usage)}</td>
                      <td className="px-6 py-3 text-sm text-gray-600">{formatTokens(u.token_allowance)}</td>
                      <td className="px-6 py-3">
                        <span className={`text-sm font-medium ${pctColor}`}>{pct}%</span>
                      </td>
                      <td className="px-6 py-3 text-sm text-gray-600">{formatBytes(u.storage_used_bytes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Most active projects */}
      {stats.byProject?.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 p-6">
          <h3 className="font-display font-semibold text-sm text-cail-dark mb-4">Most Active Projects</h3>
          <div className="space-y-2">
            {stats.byProject.map((p) => (
              <div key={p.project_id} className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-cail-dark">{p.project_name}</span>
                  <span className="text-xs text-gray-400 ml-2">({p.owner_email})</span>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <span>{p.calls} calls</span>
                  <span>{formatTokens(p.total_tokens)} tokens</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Backups Tab
// ---------------------------------------------------------------------------

function BackupsTab({ setToast }) {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadBackups();
  }, []);

  async function loadBackups() {
    setLoading(true);
    try {
      const data = await api.get('/api/admin/backups');
      setBackups(data.backups || []);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function createBackup() {
    setCreating(true);
    setError('');
    try {
      const result = await api.post('/api/admin/backups');
      setToast(`Backup created: ${result.filename} (${formatBytes(result.size)})`);
      setTimeout(() => setToast(''), 5000);
      await loadBackups();
    } catch (err) {
      setError('Backup failed: ' + err.message);
    }
    setCreating(false);
  }

  async function deleteBackup(filename) {
    if (!window.confirm(`Delete backup ${filename}?`)) return;
    try {
      await api.del(`/api/admin/backups/${encodeURIComponent(filename)}`);
      setToast('Backup deleted.');
      setTimeout(() => setToast(''), 3000);
      await loadBackups();
    } catch (err) {
      setError(err.message);
    }
  }

  function downloadBackup(filename) {
    // Direct download via link
    const a = document.createElement('a');
    a.href = `${BASE}/api/admin/backups/${encodeURIComponent(filename)}`;
    a.download = filename;
    a.click();
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display font-semibold text-lg text-cail-dark">Database & File Backups</h2>
          <p className="text-sm text-gray-500 mt-1">Create and manage backups of the database and uploaded files.</p>
        </div>
        <button
          onClick={createBackup}
          disabled={creating}
          className="px-6 py-2.5 rounded-full bg-cail-blue text-white font-medium text-sm hover:bg-cail-navy transition-colors disabled:opacity-50"
        >
          {creating ? 'Creating...' : 'Create Backup'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 font-medium hover:underline">Dismiss</button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
        </div>
      ) : backups.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
          <p className="text-gray-500 text-sm">No backups yet. Create your first backup above.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Filename</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Size</th>
                <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Created</th>
                <th className="text-right text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {backups.map((b) => (
                <tr key={b.filename} className="hover:bg-gray-50/50">
                  <td className="px-6 py-4 text-sm text-cail-dark font-mono">{b.filename}</td>
                  <td className="px-6 py-4 text-sm text-gray-600">{formatBytes(b.size)}</td>
                  <td className="px-6 py-4 text-sm text-gray-400">{formatDate(b.created_at)}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => downloadBackup(b.filename)}
                        className="px-3 py-1 rounded-full bg-cail-blue/10 text-cail-blue text-xs font-medium hover:bg-cail-blue/20 transition-colors"
                      >
                        Download
                      </button>
                      <button
                        onClick={() => deleteBackup(b.filename)}
                        className="px-3 py-1 rounded-full bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Admin Panel
// ---------------------------------------------------------------------------

export default function AdminPanel() {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      const data = await api.get('/api/admin/users');
      setUsers(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Toast */}
      {toast && (
        <div className="fixed top-20 right-4 z-50 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm shadow-lg">
          {toast}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display font-semibold text-2xl text-cail-dark">Admin Panel</h1>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 font-medium hover:underline">Dismiss</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-8 bg-gray-100 rounded-full p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-white text-cail-dark shadow-sm'
                : 'text-gray-500 hover:text-cail-dark'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && tab === 'users' && (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
        </div>
      )}

      {/* Tab content */}
      {!loading && tab === 'users' && (
        <UsersTab
          users={users}
          onRefresh={loadUsers}
          toast={toast}
          setToast={setToast}
          error={error}
          setError={setError}
        />
      )}
      {tab === 'usage' && <UsageTab />}
      {tab === 'backups' && <BackupsTab setToast={setToast} />}
    </div>
  );
}
