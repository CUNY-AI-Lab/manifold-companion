import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog focus: move focus into the dialog when it opens, keep Tab and
 * Shift+Tab inside it, close on Escape, and give focus back to the control
 * that opened it when it closes.
 */
export default function useFocusTrap(containerRef, isOpen, onClose) {
  const previousFocusRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen || !containerRef.current) return undefined;
    previousFocusRef.current = document.activeElement;
    const container = containerRef.current;
    const first = container.querySelector(FOCUSABLE);
    (first ?? container).focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape' && closeRef.current) { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const els = [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!els.length) { e.preventDefault(); return; }
      const head = els[0];
      const tail = els[els.length - 1];
      if (e.shiftKey && document.activeElement === head) { e.preventDefault(); tail.focus(); }
      else if (!e.shiftKey && document.activeElement === tail) { e.preventDefault(); head.focus(); }
    }

    container.addEventListener('keydown', handleKeyDown);
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      const back = previousFocusRef.current;
      if (back && back.isConnected && back.focus) back.focus();
    };
  }, [isOpen, containerRef]);
}
