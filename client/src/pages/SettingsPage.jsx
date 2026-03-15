import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({ id, icon, title, description, children }) {
  return (
    <section id={id} className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 shadow-sm overflow-hidden">
      <div className="px-6 py-5 border-b border-gray-100 dark:border-slate-700 flex items-center gap-3">
        <span className="text-cail-blue">{icon}</span>
        <div>
          <h2 className="font-display font-semibold text-base text-cail-dark dark:text-slate-100">{title}</h2>
          {description && <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">{description}</p>}
        </div>
      </div>
      <div className="px-6 py-5 space-y-5">
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Toggle switch
// ---------------------------------------------------------------------------

function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex items-center justify-between gap-4 py-3 border-b border-gray-50 dark:border-slate-700/50 last:border-0 cursor-pointer group">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-cail-dark dark:text-slate-200 group-hover:text-cail-blue transition-colors">{label}</p>
        {description && <p className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">{description}</p>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cail-blue focus-visible:ring-offset-2 ${
          checked ? 'bg-cail-blue' : 'bg-gray-200 dark:bg-slate-600'
        }`}
      >
        <span
          className={`absolute top-[3px] left-[3px] w-[18px] h-[18px] bg-white rounded-full shadow-sm transition-transform duration-200 ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Inline feedback message
// ---------------------------------------------------------------------------

function Feedback({ type, message }) {
  if (!message) return null;
  const styles = {
    success: 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800',
    error: 'bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800',
  };
  return (
    <div className={`rounded-xl px-4 py-2.5 text-sm ${styles[type]}`}>
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressBar({ value, max, colorClass = 'bg-cail-blue' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const isHigh = pct >= 85;
  return (
    <div className="h-2 bg-gray-100 dark:bg-slate-700 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${isHigh ? 'bg-amber-500' : colorClass}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile section
// ---------------------------------------------------------------------------

function ProfileSection({ user }) {
  const { updateProfile } = useAuth();
  const [name, setName] = useState(user?.display_name || '');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type, message }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await updateProfile(name.trim());
      setFeedback({ type: 'success', message: 'Display name updated.' });
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Failed to save.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      id="profile"
      title="Profile"
      description="How you appear to collaborators"
      icon={
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      }
    >
      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="Your name"
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700 text-sm text-cail-dark dark:text-slate-100 placeholder-gray-300 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cail-blue/40 focus:border-cail-blue transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={user?.email || ''}
              readOnly
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50/50 dark:bg-slate-700/50 text-sm text-gray-400 dark:text-slate-500 cursor-not-allowed"
            />
          </div>
        </div>
        <Feedback type={feedback?.type} message={feedback?.message} />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 rounded-full text-sm font-medium text-white bg-cail-blue hover:bg-cail-navy disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Name'}
          </button>
        </div>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Password section
// ---------------------------------------------------------------------------

function PasswordSection() {
  const [fields, setFields] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setFeedback(null);

    if (fields.newPassword !== fields.confirmPassword) {
      setFeedback({ type: 'error', message: 'New passwords do not match.' });
      return;
    }
    if (fields.newPassword.length < 8) {
      setFeedback({ type: 'error', message: 'New password must be at least 8 characters.' });
      return;
    }

    setSaving(true);
    try {
      await api.post('/api/auth/change-password', {
        currentPassword: fields.currentPassword,
        newPassword: fields.newPassword,
      });
      setFeedback({ type: 'success', message: 'Password changed successfully.' });
      setFields({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      setFeedback({ type: 'error', message: err.message || 'Failed to change password.' });
    } finally {
      setSaving(false);
    }
  }

  const update = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Section
      id="password"
      title="Password"
      description="Keep your account secure"
      icon={
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-3">
          {[
            { key: 'currentPassword', label: 'Current Password' },
            { key: 'newPassword', label: 'New Password' },
            { key: 'confirmPassword', label: 'Confirm New Password' },
          ].map(({ key, label }) => (
            <div key={key}>
              <label className="block text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
                {label}
              </label>
              <input
                type="password"
                value={fields[key]}
                onChange={update(key)}
                required
                autoComplete={key === 'currentPassword' ? 'current-password' : 'new-password'}
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-700 text-sm text-cail-dark dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-cail-blue/40 focus:border-cail-blue transition-colors"
              />
            </div>
          ))}
        </div>
        <Feedback type={feedback?.type} message={feedback?.message} />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 rounded-full text-sm font-medium text-white bg-cail-blue hover:bg-cail-navy disabled:opacity-50 transition-colors"
          >
            {saving ? 'Changing…' : 'Change Password'}
          </button>
        </div>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Appearance section
// ---------------------------------------------------------------------------

function AppearanceSection({ user }) {
  const { updateTheme } = useAuth();
  const current = user?.theme_preference || 'system';

  const options = [
    {
      value: 'system',
      label: 'System',
      description: 'Follows your OS preference',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" strokeWidth={1.8} />
          <path strokeLinecap="round" strokeWidth={1.8} d="M8 21h8M12 17v4" />
        </svg>
      ),
    },
    {
      value: 'light',
      label: 'Light',
      description: 'Always use light mode',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" strokeWidth={1.8} />
          <path strokeLinecap="round" strokeWidth={1.8} d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      ),
    },
    {
      value: 'dark',
      label: 'Dark',
      description: 'Always use dark mode',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" />
        </svg>
      ),
    },
  ];

  return (
    <Section
      id="appearance"
      title="Appearance"
      description="Choose how Manifold Companion looks"
      icon={
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
        </svg>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        {options.map((opt) => {
          const active = current === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => updateTheme(opt.value)}
              className={`group relative flex flex-col items-center gap-2.5 p-4 rounded-2xl border-2 transition-all duration-200 ${
                active
                  ? 'border-cail-blue bg-cail-blue/5 dark:bg-cail-blue/10'
                  : 'border-gray-100 dark:border-slate-700 hover:border-gray-200 dark:hover:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700/50'
              }`}
            >
              <span className={`transition-colors ${active ? 'text-cail-blue' : 'text-gray-400 dark:text-slate-500 group-hover:text-gray-600 dark:group-hover:text-slate-300'}`}>
                {opt.icon}
              </span>
              <div className="text-center">
                <p className={`text-sm font-semibold ${active ? 'text-cail-blue' : 'text-cail-dark dark:text-slate-200'}`}>
                  {opt.label}
                </p>
                <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-0.5 leading-tight">{opt.description}</p>
              </div>
              {active && (
                <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-cail-blue" />
              )}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Notifications section
// ---------------------------------------------------------------------------

const PREF_ITEMS = [
  {
    key: 'email_ocr_complete',
    label: 'OCR complete',
    description: 'Email when OCR processing finishes on a document',
  },
  {
    key: 'email_project_shared',
    label: 'Project shared',
    description: 'Email when someone shares a project with you',
  },
  {
    key: 'email_comment_reply',
    label: 'Comment replies',
    description: 'Email when someone replies to your comment',
  },
  {
    key: 'email_comment_mention',
    label: '@Mentions',
    description: 'Email when someone mentions you in a comment',
  },
];

function NotificationsSection() {
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/auth/settings')
      .then((data) => setPrefs(data.notification_preferences))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function toggle(key) {
    if (!prefs) return;
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    try {
      await api.put('/api/auth/settings', {
        notification_preferences: { [key]: !prefs[key] },
      });
    } catch {
      // revert on failure
      setPrefs(prefs);
    }
  }

  return (
    <Section
      id="notifications"
      title="Email Notifications"
      description="Control which events send you an email"
      icon={
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
      }
    >
      {loading ? (
        <div className="flex justify-center py-4">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-cail-blue border-t-transparent" />
        </div>
      ) : prefs ? (
        <div className="divide-y divide-gray-50 dark:divide-slate-700/50">
          {PREF_ITEMS.map((item) => (
            <Toggle
              key={item.key}
              label={item.label}
              description={item.description}
              checked={!!prefs[item.key]}
              onChange={() => toggle(item.key)}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400">Could not load preferences.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Usage section
// ---------------------------------------------------------------------------

function UsageSection({ user }) {
  const tokenUsed = user?.token_usage ?? 0;
  const tokenMax = user?.token_allowance ?? 5_000_000;
  const storageUsed = user?.storage_used ?? 0;

  const tokenPct = tokenMax > 0 ? Math.min(100, (tokenUsed / tokenMax) * 100) : 0;
  const storagePct = MAX_STORAGE_BYTES > 0 ? Math.min(100, (storageUsed / MAX_STORAGE_BYTES) * 100) : 0;

  return (
    <Section
      id="usage"
      title="Usage"
      description="Your resource consumption this period"
      icon={
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      }
    >
      <div className="space-y-5">
        {/* Token usage */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-cail-dark dark:text-slate-200">AI Token Usage</p>
              <p className="text-xs text-gray-400 dark:text-slate-500">Resets when admin resets your allowance</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold text-cail-dark dark:text-slate-100 tabular-nums">
                {formatTokens(tokenUsed)}
              </p>
              <p className="text-xs text-gray-400 dark:text-slate-500 tabular-nums">
                of {formatTokens(tokenMax)}
              </p>
            </div>
          </div>
          <ProgressBar value={tokenUsed} max={tokenMax} colorClass="bg-cail-blue" />
          <p className="text-xs text-gray-400 dark:text-slate-500 mt-1.5 text-right">
            {tokenPct.toFixed(1)}% used
          </p>
        </div>

        <div className="h-px bg-gray-50 dark:bg-slate-700" />

        {/* Storage */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-cail-dark dark:text-slate-200">File Storage</p>
              <p className="text-xs text-gray-400 dark:text-slate-500">Uploaded images and source PDFs</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold text-cail-dark dark:text-slate-100 tabular-nums">
                {formatBytes(storageUsed)}
              </p>
              <p className="text-xs text-gray-400 dark:text-slate-500">
                of {formatBytes(MAX_STORAGE_BYTES)}
              </p>
            </div>
          </div>
          <ProgressBar value={storageUsed} max={MAX_STORAGE_BYTES} colorClass="bg-cail-teal" />
          <p className="text-xs text-gray-400 dark:text-slate-500 mt-1.5 text-right">
            {storagePct.toFixed(1)}% used
          </p>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Side nav
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { id: 'profile', label: 'Profile' },
  { id: 'password', label: 'Password' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'usage', label: 'Usage' },
];

function SideNav({ active }) {
  function scrollTo(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <nav className="hidden lg:block w-44 shrink-0">
      <div className="sticky top-24 space-y-0.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-slate-500 px-3 mb-3">
          Settings
        </p>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => scrollTo(item.id)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
              active === item.id
                ? 'bg-cail-blue/10 text-cail-blue font-medium'
                : 'text-gray-500 dark:text-slate-400 hover:text-cail-dark dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { user } = useAuth();
  const [activeSection, setActiveSection] = useState('profile');

  // Track which section is in view for side nav highlighting
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 }
    );

    for (const item of NAV_ITEMS) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-cail-dark dark:text-slate-100">Settings</h1>
        <p className="text-sm text-gray-400 dark:text-slate-500 mt-1">
          Manage your account, appearance, and preferences
        </p>
      </div>

      <div className="flex gap-8">
        <SideNav active={activeSection} />

        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-6">
          <ProfileSection user={user} />
          <PasswordSection />
          <AppearanceSection user={user} />
          <NotificationsSection />
          <UsageSection user={user} />
        </div>
      </div>
    </div>
  );
}
