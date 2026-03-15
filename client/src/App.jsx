import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Header from './components/Header';
import Footer from './components/Footer';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import Dashboard from './pages/Dashboard';
import ProjectRoute from './pages/ProjectRoute';
import TextRoute from './pages/TextRoute';
import AdminPanel from './pages/AdminPanel';
import SearchPage from './pages/SearchPage';
import AboutPage from './pages/AboutPage';
import NotificationsPage from './pages/NotificationsPage';

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
    <div className="min-h-screen flex flex-col bg-cail-cream">
      {user && <Header />}
      <main className={`flex-1 ${user ? 'pt-16' : ''}`}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/projects/:id" element={<ProtectedRoute><ProjectRoute /></ProtectedRoute>} />
          <Route path="/texts/:id" element={<ProtectedRoute><TextRoute /></ProtectedRoute>} />
          <Route path="/search" element={<ProtectedRoute><SearchPage /></ProtectedRoute>} />
          <Route path="/about" element={<ProtectedRoute><AboutPage /></ProtectedRoute>} />
          <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute adminOnly><AdminPanel /></ProtectedRoute>} />
        </Routes>
      </main>
      {user && <Footer />}
    </div>
  );
}
