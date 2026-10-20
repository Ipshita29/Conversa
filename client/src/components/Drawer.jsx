import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// Right-hand slide-over. Escape or backdrop click closes; focus moves to the close button on open.
export default function Drawer({ title, onClose, children }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" data-lenis-prevent role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-header">
          <h2>{title}</h2>
          <button type="button" ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}
