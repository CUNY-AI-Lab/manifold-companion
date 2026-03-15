import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { BASE } from '../api/client';
import SearchBar from './SearchBar';
import NotificationBell from './NotificationBell';

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
  const { user, logout } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLinks = [
    { to: '/', label: 'Dashboard' },
    ...(user?.role === 'admin' ? [{ to: '/admin', label: 'Admin' }] : []),
    { to: '/about', label: 'About' },
  ];

  const isActive = (path) => location.pathname === path;

  return (
    <header className="fixed top-0 w-full z-50 bg-white/95 backdrop-blur-md border-b border-gray-200/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Left: Logo + Title */}
          <Link to="/" className="flex items-center gap-3 group">
            <img
              src={`${BASE}/images/cail-logo-horizontal.png`}
              alt="CUNY AI Lab"
              className="h-8 w-auto"
            />
            <span className="font-display font-semibold text-cail-dark text-sm hidden lg:block">
              Manifold Companion
            </span>
          </Link>

          {/* Center: Nav links (desktop) */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  isActive(link.to)
                    ? 'bg-cail-blue/10 text-cail-blue'
                    : 'text-gray-600 hover:text-cail-dark hover:bg-gray-100'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right: Search + Notifications + User + Logout (desktop) */}
          <div className="hidden md:flex items-center gap-4">
            <SearchBar compact />
            <NotificationBell />
            <span className="text-sm text-gray-500">{user?.display_name || user?.email}</span>
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
              className="p-2 rounded-lg text-gray-600 hover:bg-gray-100"
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
          <div className="md:hidden border-t border-gray-100 py-3 space-y-1">
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
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {link.label}
              </Link>
            ))}
            <div className="border-t border-gray-100 pt-3 mt-3 px-4">
              <p className="text-sm text-gray-500 mb-2">{user?.display_name || user?.email}</p>
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
