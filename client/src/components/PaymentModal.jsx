import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';

// A large, centred dialog for one order's payments. Closing by clicking outside or pressing Escape is refused while a form is open
// (unsaved changes) or a request is in flight (pending action); the close button is refused only while a request is in flight.
// Panels inside report their state through the guard.
const Guard = createContext({ setDirty() {}, setBusy() {} });
export const useGuard = () => useContext(Guard);

export default function PaymentModal({ title, onClose, refreshing = false, children }) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''); // why a close was refused, shown briefly
  const [shake, setShake] = useState(false);
  const box = useRef(null); const closeBtn = useRef(null);
  const noticeTimer = useRef(0);
  const state = useRef({ dirty, busy }); state.current = { dirty, busy };

  const tryClose = useCallback((explicit) => {
    const { dirty: d, busy: b } = state.current;
    if (b || (!explicit && d)) { setNotice(b ? 'Saving… please wait a moment.' : 'Finish or cancel the open form first.'); setShake(true); setTimeout(() => setShake(false), 420); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 3200); return; } // refused: shake the dialog and say why
    onClose();
  }, [onClose]);

  useEffect(() => {
    const before = document.activeElement;
    closeBtn.current?.focus();
    document.documentElement.classList.add('pm-lock');
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (!document.querySelector('.payments .modal-backdrop')) tryClose(false); return; } // a screenshot viewer or form on top closes first
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(noticeTimer.current); document.removeEventListener('keydown', onKey); document.documentElement.classList.remove('pm-lock'); before?.focus?.(); };
  }, [tryClose]);

  const guard = useMemo(() => ({ setDirty, setBusy }), []);
  return (
    <Guard.Provider value={guard}>
      <div className="pm-backdrop" data-lenis-prevent onMouseDown={(e) => e.target === e.currentTarget && tryClose(false)}>
        <div className={`pm-modal${shake ? ' is-nudged' : ''}`} ref={box} role="dialog" aria-modal="true" aria-label={title}>
          <button type="button" ref={closeBtn} className="pm-x" onClick={() => tryClose(true)} aria-label="Close payment details" disabled={busy}><X size={18} aria-hidden="true" /></button>
          <div className="pm-modal-body" data-lenis-prevent>{children}</div>
          <p className="pm-modal-live" role="status" aria-live="polite">{notice || (refreshing && !busy ? 'Updating…' : '')}</p>
        </div>
      </div>
    </Guard.Provider>
  );
}
