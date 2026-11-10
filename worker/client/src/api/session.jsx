import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './client';
import { ownerOf, purgeDrafts } from '../lib/drafts';
import { browserStorage } from '../lib/storage';

const SessionContext = createContext(null);

function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', !!dark);
}

/** The session comes from GET /api/session; there is no login page, Doorway signs people in. */
export function SessionProvider({ children }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [draftOwner, setDraftOwner] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/api/session');
      setSession(s);
      setError(null);
      applyTheme(s.profile.theme_preference);
      // Drafts are keyed by a hash of the subject. Someone else's (a person who signed out here) go now.
      ownerOf(s.subject).then((owner) => { purgeDrafts(browserStorage(), owner); setDraftOwner(owner); }, () => setDraftOwner(null));
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

  return <SessionContext.Provider value={{ session, error, refresh, updateProfile, draftOwner }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
