import { Link, useLocation } from 'react-router-dom';

export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="max-w-xl mx-auto px-4 py-24 text-center">
      <h1 className="font-display text-6xl font-bold text-cail-dark dark:text-slate-200 mb-4">404</h1>
      <p className="text-lg text-gray-500 dark:text-slate-400 mb-2">Page not found</p>
      <p className="text-sm text-gray-400 dark:text-slate-500 mb-8 font-mono break-all">{pathname}</p>
      <Link
        to="/"
        className="inline-flex items-center px-5 py-2.5 bg-cail-blue text-white rounded-xl font-medium hover:bg-cail-blue/90 transition-colors"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
