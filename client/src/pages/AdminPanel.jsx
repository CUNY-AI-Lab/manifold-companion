import { useState, useEffect } from 'react';
import { api } from '../api/client';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)} ${units[i]}`;
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

export default function AdminPanel() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

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

  async function updateStatus(userId, status) {
    try {
      await api.put(`/api/admin/users/${userId}/status`, { status });
      setToast(`User ${status === 'approved' ? 'approved' : 'disabled'}.`);
      setTimeout(() => setToast(''), 3000);
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteUser(userId) {
    try {
      await api.del(`/api/admin/users/${userId}`);
      setConfirmDelete(null);
      setToast('User deleted.');
      setTimeout(() => setToast(''), 3000);
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  // Stats
  const totalUsers = users.length;
  const pendingUsers = users.filter((u) => u.status === 'pending').length;
  const totalStorage = users.reduce((acc, u) => acc + (u.storage_used_bytes || 0), 0);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Toast */}
      {toast && (
        <div className="fixed top-20 right-4 z-50 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm shadow-lg">
          {toast}
        </div>
      )}

      <h1 className="font-display font-semibold text-2xl text-cail-dark mb-6">User Management</h1>

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 font-medium hover:underline">Dismiss</button>
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">Total Users</p>
          <p className="font-display font-semibold text-2xl text-cail-dark">{totalUsers}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">Pending Approvals</p>
          <p className="font-display font-semibold text-2xl text-yellow-600">{pendingUsers}</p>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500 mb-1">Total Storage Used</p>
          <p className="font-display font-semibold text-2xl text-cail-dark">{formatBytes(totalStorage)}</p>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
        </div>
      )}

      {/* Users table */}
      {!loading && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Email</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Status</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Role</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Storage</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Projects</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Last Login</th>
                  <th className="text-right text-xs font-medium text-gray-500 uppercase tracking-wider px-6 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4 text-sm text-cail-dark">{user.email}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${STATUS_STYLES[user.status] || 'bg-gray-50 text-gray-600'}`}>
                        {user.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">{user.role}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{formatBytes(user.storage_used_bytes)}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{user.project_count || 0}</td>
                    <td className="px-6 py-4 text-sm text-gray-400">{formatDate(user.last_login_at)}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        {user.status === 'pending' && (
                          <button
                            onClick={() => updateStatus(user.id, 'approved')}
                            className="px-3 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100 transition-colors"
                          >
                            Approve
                          </button>
                        )}
                        {user.status === 'approved' && user.role !== 'admin' && (
                          <button
                            onClick={() => updateStatus(user.id, 'disabled')}
                            className="px-3 py-1 rounded-full bg-yellow-50 text-yellow-700 text-xs font-medium hover:bg-yellow-100 transition-colors"
                          >
                            Disable
                          </button>
                        )}
                        {user.status === 'disabled' && (
                          <button
                            onClick={() => updateStatus(user.id, 'approved')}
                            className="px-3 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100 transition-colors"
                          >
                            Enable
                          </button>
                        )}
                        {user.role !== 'admin' && (
                          <button
                            onClick={() => setConfirmDelete(user)}
                            className="px-3 py-1 rounded-full bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors"
                          >
                            Delete
                          </button>
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
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6">
            <h3 className="font-display font-semibold text-lg text-cail-dark mb-2">Delete User</h3>
            <p className="text-sm text-gray-600 mb-6">
              Are you sure you want to delete <strong>{confirmDelete.email}</strong>? This will remove all their projects and data. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-full text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteUser(confirmDelete.id)}
                className="px-4 py-2 rounded-full bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
              >
                Delete User
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
