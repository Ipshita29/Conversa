import { MessageCircle, Camera, PenLine } from 'lucide-react';
import { STATUS_LABEL, PAYMENT_LABEL, CHANNEL_LABEL, RISK_LABEL } from '../utils/format.js';

export const StatusBadge = ({ status }) => <span className={`badge status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
export const PaymentBadge = ({ status }) => <span className={`badge pay-${status}`}>{PAYMENT_LABEL[status] ?? status}</span>;

// Risk is conveyed by icon-free text + colour + a shape marker so it is not colour-only.
export function RiskBadge({ risk }) {
  if (!risk) return <span className="badge risk-none" title="Needs prep time and deadline to assess">Not assessed</span>;
  return <span className={`badge risk-${risk}`}><i className="risk-dot" aria-hidden="true" />{RISK_LABEL[risk]}</span>;
}

const ICONS = { whatsapp: MessageCircle, instagram: Camera, manual: PenLine };
export function ChannelBadge({ channel }) {
  const Icon = ICONS[channel] ?? PenLine;
  return <span className={`badge channel-${channel}`}><Icon size={12} aria-hidden="true" />{CHANNEL_LABEL[channel] ?? channel}</span>;
}
