import { Route, Routes } from 'react-router-dom';
import { useSession } from './api/session.jsx';
import { AnnounceProvider } from './hooks/useAnnounce.jsx';
import Header from './components/Header';
import { ConfirmProvider } from './components/ConfirmDialog';
import { DataNotice, ErrorNote, Spinner } from './components/ui';
import Dashboard from './pages/Dashboard';
import ProjectPage from './pages/ProjectPage';
import TextRoute from './pages/TextRoute';
import InvitePage from './pages/InvitePage';
import SettingsPage from './pages/SettingsPage';
import NotificationsPage from './pages/NotificationsPage';
import SearchPage from './pages/SearchPage';
import HelpPage from './pages/HelpPage';
import { useNoFileNavigation } from './hooks/useFileDrop';
import { ShortcutProvider } from './hooks/useShortcuts';

function NotFound() {
  return <div className="mx-auto max-w-3xl px-4 py-10"><h1 className="text-xl">Page not found</h1><p className="mt-2 text-sm">Go back to <a href="./">your projects</a>.</p></div>;
}

export default function App() {
  const { session, error } = useSession();
  useNoFileNavigation();
  // There is no sign-in page: Doorway signs people in before this app loads. A
  // lost session navigates away inside the API client.
  if (!session) {
    return error ? <div className="mx-auto max-w-xl p-8"><ErrorNote error={error} /></div> : <div className="mx-auto max-w-xl p-8"><Spinner /></div>;
  }
  return (
    <AnnounceProvider>
      <ConfirmProvider>
      <ShortcutProvider>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:bg-white focus:px-4 focus:py-2">Skip to content</a>
      <div className="flex min-h-screen flex-col">
        <Header />
        <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/texts/:id" element={<TextRoute />} />
            <Route path="/invite" element={<InvitePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        <footer className="mx-auto w-full max-w-6xl px-4 pb-6"><DataNotice /></footer>
      </div>
      </ShortcutProvider>
      </ConfirmProvider>
    </AnnounceProvider>
  );
}
