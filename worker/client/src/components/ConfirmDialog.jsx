import { createContext, useCallback, useContext, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';

const ConfirmContext = createContext(null);

function Dialog({ request, onAnswer }) {
  const ref = useRef(null);
  useFocusTrap(ref, true, () => onAnswer(false));
  const { title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false } = request;
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" tabIndex={-1} className="mt-24 w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">
        <h2 id="confirm-title" className="text-lg">{title}</h2>
        <p id="confirm-message" className="mt-2 whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          {/* Cancel first: it takes focus when the dialog opens, so Enter never confirms by accident. */}
          <button type="button" className="btn-quiet" onClick={() => onAnswer(false)}>{cancelLabel}</button>
          <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => onAnswer(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/** App-wide confirmation: `await confirm({ title, message, confirmLabel, danger })` resolves true or false. */
export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const confirm = useCallback((r) => new Promise((resolve) => setRequest({ ...r, resolve })), []);
  const answer = (value) => {
    const r = request;
    setRequest(null);
    r?.resolve(value);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request ? <Dialog request={request} onAnswer={answer} /> : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm outside ConfirmProvider');
  return confirm;
}
