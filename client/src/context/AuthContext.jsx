import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);

const THEME_KEY = 'mc-theme';

function applyTheme(pref) {
  const html = document.documentElement;
  if (pref === 'dark') {
    html.classList.add('dark');
  } else if (pref === 'light') {
    html.classList.remove('dark');
  } else {
    // system
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      html.classList.add('dark');
    } else {
      html.classList.remove('dark');
    }
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const mediaListenerRef = useRef(null);

  // Apply saved theme from localStorage immediately (pre-auth, prevents flash)
  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY) || 'system';
    applyTheme(saved);
  }, []);

  // Manage system-preference media listener
  const attachSystemListener = useCallback((pref) => {
    // Remove existing listener if any
    if (mediaListenerRef.current) {
      window.matchMedia('(prefers-color-scheme: dark)')
        .removeEventListener('change', mediaListenerRef.current);
      mediaListenerRef.current = null;
    }
    if (pref === 'system') {
      const handler = (e) => {
        document.documentElement.classList.toggle('dark', e.matches);
      };
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', handler);
      mediaListenerRef.current = handler;
    }
  }, []);

  // Check session on mount
  useEffect(() => {
    api.get('/api/auth/me')
      .then((data) => {
        setUser(data);
        const pref = data?.theme_preference || 'system';
        localStorage.setItem(THEME_KEY, pref);
        applyTheme(pref);
        attachSystemListener(pref);
      })
      .catch(() => {
        setUser(null);
        // Keep using the localStorage preference applied above
        const saved = localStorage.getItem(THEME_KEY) || 'system';
        attachSystemListener(saved);
      })
      .finally(() => setLoading(false));
  }, [attachSystemListener]);

  // Clean up listener on unmount
  useEffect(() => {
    return () => {
      if (mediaListenerRef.current) {
        window.matchMedia('(prefers-color-scheme: dark)')
          .removeEventListener('change', mediaListenerRef.current);
      }
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.post('/api/auth/login', { email, password });
    setUser(data);
    const pref = data?.theme_preference || 'system';
    localStorage.setItem(THEME_KEY, pref);
    applyTheme(pref);
    attachSystemListener(pref);
    return data;
  }, [attachSystemListener]);

  const register = useCallback(async (email, password, name) => {
    const data = await api.post('/api/auth/register', { email, password, name });
    return data;
  }, []);

  const updateProfile = useCallback(async (fields) => {
    const data = await api.put('/api/auth/profile', fields);
    setUser((prev) => prev ? { ...prev, ...data } : prev);
    return data;
  }, []);

  const updateTheme = useCallback(async (pref) => {
    const data = await api.put('/api/auth/profile', { theme_preference: pref });
    setUser((prev) => prev ? { ...prev, theme_preference: pref } : prev);
    localStorage.setItem(THEME_KEY, pref);
    applyTheme(pref);
    attachSystemListener(pref);
    return data;
  }, [attachSystemListener]);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateProfile, updateTheme }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
