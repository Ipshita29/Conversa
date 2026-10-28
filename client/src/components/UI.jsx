import { MessageCircle, Camera, PenLine, X } from 'lucide-react';
import { STATUS_LABEL, PAYMENT_LABEL, CHANNEL_LABEL, RISK_LABEL } from '../utils/format.js';
import { DEMO_MODE } from '../services/api.js';
import { useEffect, useRef } from 'react';

// ---------- Badge ----------
export const StatusBadge = ({ status }) => <span className={`badge status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
export const PaymentBadge = ({ status }) => <span className={`badge pay-${status}`}>{PAYMENT_LABEL[status] ?? status}</span>;

// Risk is never conveyed by colour alone: every level has its own marker shape (diamond, triangle, circle, square) and a text label.
export function RiskBadge({ risk, needsDetails = false }) {
  if (needsDetails) return <span className="badge risk-details"><i className="risk-dot" aria-hidden="true" />Needs details</span>;
  if (!risk) return <span className="badge risk-none">—</span>;
  return <span className={`badge risk-${risk}`}><i className="risk-dot" aria-hidden="true" />{RISK_LABEL[risk]}</span>;
}

const ICONS = { whatsapp: MessageCircle, instagram: Camera, manual: PenLine };
export function ChannelBadge({ channel }) {
  const Icon = ICONS[channel] ?? PenLine;
  return <span className={`badge channel-${channel}`}><Icon size={14} aria-hidden="true" />{CHANNEL_LABEL[channel] ?? channel}</span>;
}

// ---------- DemoBadge ----------
// Renders only in demo mode so simulated data is never mistaken for live data.
export function DemoBadge({ label = 'Demo data' }) {
  if (!DEMO_MODE) return null;
  return <span className="demo-badge" title="Simulated by the in-browser mock backend (src/mock)">{label}</span>;
}

// ---------- Modal ----------
export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-lenis-prevent role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---------- Drawer ----------
// Right-hand slide-over. Escape or backdrop click closes; focus moves to the close button on open.
export function Drawer({ title, onClose, children }) {
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

// ---------- StateMessage ----------
export function StateMessage({ kind = 'empty', message, onRetry, children }) {
  return (
    <div className={`state-message state-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p>{message}</p>
      {children}
      {onRetry && <button type="button" className="btn btn-primary" onClick={onRetry}>Try again</button>}
    </div>
  );
}
