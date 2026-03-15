import { useState, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { BASE } from '../api/client';
import SearchBar from './SearchBar';
import NotificationBell from './NotificationBell';
import useHotkeys from '../hooks/useHotkeys';

const THEME_CYCLE = ['system', 'light', 'dark'];

function ThemeIcon({ pref }) {
  if (pref === 'light') {
    return (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" strokeWidth="2" />
        <path strokeLinecap="round" strokeWidth="2" d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    );
  }
  if (pref === 'dark') {
    return (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" />
      </svg>
    );
  }
  // system / monitor
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" strokeWidth="2" />
      <path strokeLinecap="round" strokeWidth="2" d="M8 21h8M12 17v4" />
    </svg>
  );
}

const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

function ManifoldLogo({ className = '' }) {
  return (
    <svg viewBox="0 0 34 35" width="38" height="38" xmlns="http://www.w3.org/2000/svg" className={className}>
      <title>Manifold Logo</title>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M33.6 11.2l-2.5.8-3.9-1.5 6.4-2V6.3l-9.5 3.1-3.9-1.5 13.4-4.3V1.4L17.1 6.7.4.2v13.9L16 9.2v2.7L.4 16.8V19L16 14.1v2.7L.4 21.7v2.2L16 19v2.7L.4 26.6v2.2L16 23.9v2.7L.4 31.5v2.2L17 28.5l16.6 6.4z"
        fill="currentColor"
      />
    </svg>
  );
}

export { ManifoldLogo };

export default function Header() {
  const { user, logout, updateTheme } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const pendingKeyRef = useRef(null);
  const pendingTimerRef = useRef(null);

  const currentThemePref = user?.theme_preference || localStorage.getItem('mc-theme') || 'system';

  function cycleTheme() {
    const idx = THEME_CYCLE.indexOf(currentThemePref);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    updateTheme(next);
  }

  // Global shortcuts
  useHotkeys({
    'Cmd+Shift+D': { handler: () => cycleTheme(), label: 'Cycle theme', section: 'Global' },
    '/': { handler: () => { const el = document.querySelector('[data-search-input]'); if (el) el.focus(); }, label: 'Focus search', section: 'Global' },
  }, { when: !!user });

  // Two-key "Go to" combos — g sets up a one-time follow-up listener
  useHotkeys({
    'g': {
      handler: () => {
        clearTimeout(pendingTimerRef.current);
        function followUp(e) {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
          window.removeEventListener('keydown', followUp);
          clearTimeout(pendingTimerRef.current);
          if (e.key === 'd') { e.preventDefault(); navigate('/'); }
          else if (e.key === 's') { e.preventDefault(); navigate('/settings'); }
        }
        window.addEventListener('keydown', followUp);
        pendingTimerRef.current = setTimeout(() => { window.removeEventListener('keydown', followUp); }, 500);
      },
      label: 'Go to... (G D=Dashboard, G S=Settings)',
      section: 'Global',
    },
  }, { when: !!user });

  const navLinks = [
    { to: '/', label: 'Dashboard' },
    ...(user?.role === 'admin' ? [{ to: '/admin', label: 'Admin' }] : []),
    { to: '/about', label: 'About' },
  ];

  const isActive = (path) => location.pathname === path;

  return (
    <header role="banner" className="fixed top-0 w-full z-50 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border-b border-gray-200/80 dark:border-slate-700/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Left: Logo + Title */}
          <Link to="/" className="flex items-center gap-3 group">
            <img
              src={`${BASE}/images/cail-logo-horizontal.png`}
              alt="CUNY AI Lab"
              className="h-8 w-auto"
            />
            <span className="font-display font-semibold text-cail-dark dark:text-slate-200 text-sm hidden lg:block">
              Manifold Companion
            </span>
          </Link>

          {/* Center: Nav links (desktop) */}
          <nav aria-label="Main navigation" className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  isActive(link.to)
                    ? 'bg-cail-blue/10 text-cail-blue'
                    : 'text-gray-600 dark:text-slate-400 hover:text-cail-dark dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right: Search + Theme toggle + Notifications + User + Logout (desktop) */}
          <div className="hidden md:flex items-center gap-4">
            <SearchBar compact />
            <div className="relative group">
              <button
                onClick={cycleTheme}
                className="p-2 rounded-full text-gray-500 dark:text-slate-400 hover:text-cail-dark dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                aria-label={`Theme: ${THEME_LABEL[currentThemePref]}. Click to cycle.`}
              >
                <ThemeIcon pref={currentThemePref} />
              </button>
              <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 rounded text-xs font-medium text-white bg-gray-800 dark:bg-slate-600 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                {THEME_LABEL[currentThemePref]}
              </span>
            </div>
            <NotificationBell />
            <span className="text-sm text-gray-500 dark:text-slate-400">{user?.display_name || user?.email}</span>
            <div className="relative group">
              <Link
                to="/settings"
                className={`p-2 rounded-full transition-colors ${isActive('/settings') ? 'text-cail-blue bg-cail-blue/10' : 'text-gray-500 dark:text-slate-400 hover:text-cail-dark dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-700'}`}
                aria-label="Settings"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </Link>
              <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-1 rounded text-xs font-medium text-white bg-gray-800 dark:bg-slate-600 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                Settings
              </span>
            </div>
            <button
              onClick={logout}
              className="px-4 py-1.5 rounded-full text-sm font-medium text-white bg-cail-blue hover:bg-cail-navy transition-colors"
            >
              Logout
            </button>
          </div>

          {/* Mobile: notifications + hamburger */}
          <div className="md:hidden flex items-center gap-1">
            <NotificationBell />
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-2 rounded-lg text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700"
              aria-label="Toggle menu"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {menuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="md:hidden border-t border-gray-100 dark:border-slate-700 py-3 space-y-1">
            <div className="px-4 pb-2">
              <SearchBar compact={false} />
            </div>
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                onClick={() => setMenuOpen(false)}
                className={`block px-4 py-2 rounded-lg text-sm font-medium ${
                  isActive(link.to)
                    ? 'bg-cail-blue/10 text-cail-blue'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                }`}
              >
                {link.label}
              </Link>
            ))}
            <div className="border-t border-gray-100 dark:border-slate-700 pt-3 mt-3 px-4">
              <p className="text-sm text-gray-500 dark:text-slate-400 mb-2">{user?.display_name || user?.email}</p>
              <button
                onClick={cycleTheme}
                className="w-full flex items-center gap-2 px-4 py-2 mb-2 rounded-full text-sm font-medium text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
                aria-label={`Theme: ${THEME_LABEL[currentThemePref]}. Click to cycle.`}
              >
                <ThemeIcon pref={currentThemePref} />
                <span>Theme: {THEME_LABEL[currentThemePref]}</span>
              </button>
              <Link
                to="/settings"
                onClick={() => setMenuOpen(false)}
                className={`w-full flex items-center gap-2 px-4 py-2 mb-2 rounded-full text-sm font-medium transition-colors ${isActive('/settings') ? 'bg-cail-blue/10 text-cail-blue' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Settings
              </Link>
              <button
                onClick={() => { logout(); setMenuOpen(false); }}
                className="w-full px-4 py-2 rounded-full text-sm font-medium text-white bg-cail-blue hover:bg-cail-navy transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
