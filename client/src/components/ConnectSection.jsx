import { Link } from 'react-router-dom';
import { ArrowRight, PenLine } from 'lucide-react';
import { WhatsAppLogo, InstagramLogo } from './ChannelLogos.jsx';

const CHANNELS = [
  { key: 'whatsapp', name: 'WhatsApp', Logo: WhatsAppLogo, purpose: 'Customer messages and order requests will arrive in your inbox, ready to turn into orders.' },
  { key: 'instagram', name: 'Instagram', Logo: InstagramLogo, purpose: 'Direct messages from your profile will land in the same inbox, next to every other conversation.' },
];

// Neither channel is wired up: the tiles are informational only (no buttons, no OAuth, no connected state).
export default function ConnectSection() {
  return (
    <div className="cx">
      <h2 className="cx-lead">Bring your conversations together.</h2>
      <div className="cx-body">
        <div className="cx-intro">
          <p className="eyebrow">Channels</p>
          <h3 className="cx-title">Your conversations. <em>One workspace.</em></h3>
          <p className="cx-text">Connect the channels where your customers already reach you, or get started by adding orders manually.</p>
        </div>

        <ul className="cx-tiles">
          {CHANNELS.map(({ key, name, Logo, purpose }) => (
            <li key={key} className={`cx-tile cx-${key}`}>
              <Logo size={44} />
              <div>
                <p className="cx-name">{name} <span className="cx-status">Coming soon · Not connected</span></p>
                <p className="cx-purpose">{purpose}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="cx-paths">
        <p className="cx-paths-label">Conversa works today, without either channel.</p>
        <div className="cx-actions">
          <Link to="/plan" className="btn btn-primary">Continue with demo data <ArrowRight size={16} aria-hidden="true" /></Link>
          <Link to="/orders?edit=new" className="btn"><PenLine size={15} aria-hidden="true" /> Add an order manually</Link>
        </div>
      </div>
    </div>
  );
}
