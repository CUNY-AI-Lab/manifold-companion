import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './client';

const SessionContext = createContext(null);

function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', !!dark);
}

/** The session comes from GET /api/session; there is no login page, Doorway signs people in. */
export function SessionProvider({ children }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/api/session');
      setSession(s);
      setError(null);
      applyTheme(s.profile.theme_preference);
      return s;
    } catch (e) {
      if (!api.navigating) setError(e);
      return null;
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const updateProfile = useCallback(async (patch) => {
    const { profile } = await api.put('/api/profile', patch);
    setSession((s) => (s ? { ...s, profile } : s));
    applyTheme(profile.theme_preference);
    return profile;
  }, []);

  return <SessionContext.Provider value={{ session, error, refresh, updateProfile }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
