import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { AnnounceProvider } from './hooks/useAnnounce.jsx';
import Header from './components/Header';
import Footer from './components/Footer';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import Dashboard from './pages/Dashboard';
import ProjectRoute from './pages/ProjectRoute';
import TextRoute from './pages/TextRoute';
import AdminPanel from './pages/AdminPanel';
import SearchPage from './pages/SearchPage';
import AboutPage from './pages/AboutPage';
import NotificationsPage from './pages/NotificationsPage';
import SettingsPage from './pages/SettingsPage';
import NotFoundPage from './pages/NotFoundPage';

function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="flex justify-center items-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
    </div>
  );
  if (!user) return <Navigate to="/login" />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/" />;
  return children;
}

export default function App() {
  const { user } = useAuth();
  return (
    <AnnounceProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[60] focus:bg-white dark:focus:bg-slate-800 focus:text-cail-dark dark:focus:text-slate-200 focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg focus:ring-2 focus:ring-cail-blue"
      >
        Skip to content
      </a>
      <div className="min-h-screen flex flex-col bg-cail-cream dark:bg-slate-900">
        {user && <Header />}
        <main id="main-content" className={`flex-1 ${user ? 'pt-16' : ''}`}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/projects/:id" element={<ProtectedRoute><ProjectRoute /></ProtectedRoute>} />
            <Route path="/texts/:id" element={<ProtectedRoute><TextRoute /></ProtectedRoute>} />
            <Route path="/search" element={<ProtectedRoute><SearchPage /></ProtectedRoute>} />
            <Route path="/about" element={<ProtectedRoute><AboutPage /></ProtectedRoute>} />
            <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
            <Route path="/admin" element={<ProtectedRoute adminOnly><AdminPanel /></ProtectedRoute>} />
            <Route path="*" element={<ProtectedRoute><NotFoundPage /></ProtectedRoute>} />
          </Routes>
        </main>
        {user && <Footer />}
      </div>
    </AnnounceProvider>
  );
}
