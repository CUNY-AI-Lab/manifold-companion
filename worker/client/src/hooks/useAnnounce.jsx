import { createContext, useContext, useRef, useCallback } from 'react';

const AnnounceContext = createContext(null);

export function AnnounceProvider({ children }) {
  const politeRef = useRef(null);
  const assertiveRef = useRef(null);

  const announce = useCallback((message, priority = 'polite') => {
    const ref = priority === 'assertive' ? assertiveRef : politeRef;
    if (!ref.current) return;
    ref.current.textContent = '';
    requestAnimationFrame(() => {
      if (ref.current) ref.current.textContent = message;
    });
  }, []);

  return (
    <>
      <AnnounceContext.Provider value={announce}>
        {children}
      </AnnounceContext.Provider>
      <div ref={politeRef} aria-live="polite" aria-atomic="true" className="sr-only" />
      <div ref={assertiveRef} aria-live="assertive" aria-atomic="true" className="sr-only" />
    </>
  );
}

export function useAnnounce() {
  const ctx = useContext(AnnounceContext);
  if (!ctx) throw new Error('useAnnounce must be used within AnnounceProvider');
  return ctx;
}
