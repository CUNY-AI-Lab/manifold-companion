import { useEffect, useRef } from 'react';

export default function useFocusTrap(containerRef, isOpen) {
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    previousFocusRef.current = document.activeElement;
    const container = containerRef.current;
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length) focusable[0].focus();

    function handleKeyDown(e) {
      if (e.key !== 'Tab') return;
      const focusableEls = container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusableEls.length) return;
      const first = focusableEls[0];
      const last = focusableEls[focusableEls.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    container.addEventListener('keydown', handleKeyDown);
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      if (previousFocusRef.current && previousFocusRef.current.focus) {
        previousFocusRef.current.focus();
      }
    };
  }, [isOpen, containerRef]);
}
