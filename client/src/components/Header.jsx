import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { BASE } from '../api/client';

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

function AboutModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Logo + Title */}
        <div className="flex items-center gap-3 mb-6">
          <ManifoldLogo className="text-cail-navy w-10 h-10" />
          <div>
            <h2 className="font-display font-semibold text-lg text-cail-dark">CAIL OCR Manifold Companion</h2>
            <p className="text-xs text-gray-400">CUNY AI Lab</p>
          </div>
        </div>

        <div className="space-y-4 text-sm text-gray-600 leading-relaxed">
          <p>
            The <strong className="text-cail-dark">Manifold Companion</strong> is a document-processing platform built by the{' '}
            <strong className="text-cail-dark">CUNY AI Lab</strong> to help researchers, students, and instructors
            digitize manuscript pages, historical documents, textbooks, and other printed or handwritten texts.
          </p>

          <p>
            It supports two workflows, designed as a companion to{' '}
            <a
              href="https://cuny.manifoldapp.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-cail-blue hover:text-cail-navy font-medium underline underline-offset-2"
            >
              CUNY&apos;s Manifold instance
            </a>
            , an open-source publishing platform where digital texts can be published, annotated,
            and shared as open-access scholarly works.
          </p>

          <div className="bg-cail-cream rounded-xl p-4 space-y-3">
            <div>
              <h3 className="font-display font-semibold text-cail-dark text-sm">Image to Markdown</h3>
              <p className="text-sm text-gray-600 mt-1">
                Best for <strong className="text-gray-700">scanned pages, photographs of documents, and handwritten texts</strong>.
                Upload images (JPEG, PNG, TIFF, BMP, WebP, HEIC) or rasterized PDFs and the platform extracts
                text via OCR into editable Markdown. Review and correct page by page, then export.
              </p>
            </div>
            <div className="border-t border-gray-200 pt-3">
              <h3 className="font-display font-semibold text-cail-dark text-sm">PDF to HTML</h3>
              <p className="text-sm text-gray-600 mt-1">
                Best for <strong className="text-gray-700">digital PDFs like textbooks, articles, and reports</strong> where
                you want to preserve structure — headings, tables, lists, and mathematical formulas.
                Upload a source PDF and the platform converts it to semantic HTML that you can edit
                in a rich-text editor.
              </p>
            </div>
          </div>

          <div className="bg-gray-50 rounded-xl p-4 space-y-2">
            <h3 className="font-display font-semibold text-cail-dark text-sm">Both workflows include</h3>
            <ul className="space-y-1.5 text-sm text-gray-600">
              <li className="flex items-start gap-2">
                <span className="text-cail-teal mt-0.5">&#10003;</span>
                AI-powered summaries and translations
              </li>
              <li className="flex items-start gap-2">
                <span className="text-cail-teal mt-0.5">&#10003;</span>
                Dublin Core metadata for scholarly cataloging
              </li>
              <li className="flex items-start gap-2">
                <span className="text-cail-teal mt-0.5">&#10003;</span>
                Export as ZIP archives ready for Manifold import
              </li>
            </ul>
          </div>

          <p className="text-xs text-gray-400 pt-2">
            Powered by AI vision and language models.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function Header() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const navLinks = [
    { to: '/', label: 'Dashboard' },
    ...(user?.role === 'admin' ? [{ to: '/admin', label: 'Admin' }] : []),
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
            <button
              onClick={() => setAboutOpen(true)}
              className="px-4 py-2 rounded-full text-sm font-medium text-gray-600 hover:text-cail-dark hover:bg-gray-100 transition-colors"
            >
              About
            </button>
          </nav>

          {/* Right: User + Logout (desktop) */}
          <div className="hidden md:flex items-center gap-4">
            <span className="text-sm text-gray-500">{user?.email}</span>
            <button
              onClick={logout}
              className="px-4 py-1.5 rounded-full text-sm font-medium text-white bg-cail-blue hover:bg-cail-navy transition-colors"
            >
              Logout
            </button>
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100"
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

        {/* Mobile menu */}
        {menuOpen && (
          <div className="md:hidden border-t border-gray-100 py-3 space-y-1">
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
            <button
              onClick={() => { setAboutOpen(true); setMenuOpen(false); }}
              className="block w-full text-left px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              About
            </button>
            <div className="border-t border-gray-100 pt-3 mt-3 px-4">
              <p className="text-sm text-gray-500 mb-2">{user?.email}</p>
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
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </header>
  );
}
