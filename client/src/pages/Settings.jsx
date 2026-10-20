import { useState } from 'react';
import { MessageCircle, Camera } from 'lucide-react';
import { getIntegrations, connectIntegration } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatDateTime, CHANNEL_LABEL } from '../utils/format.js';
import PageHeader from '../components/PageHeader.jsx';
import StateMessage from '../components/StateMessage.jsx';
import '../css/Settings.css';

const STATUS_TEXT = { connected: 'Connected', disconnected: 'Not connected', unavailable: 'Unavailable', demo: 'Demo' };
const ICON = { whatsapp: MessageCircle, instagram: Camera };

export default function Settings() {
  const { status, data, error, reload } = useAsync(getIntegrations);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState({});

  async function connect(channel) {
    setBusy(channel);
    setResult((r) => ({ ...r, [channel]: null }));
    try {
      const res = await connectIntegration(channel);
      setResult((r) => ({ ...r, [channel]: { ok: true, url: res.authorizationUrl } }));
      reload();
    } catch (e) {
      setResult((r) => ({ ...r, [channel]: { ok: false, message: e.message } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="page settings">
      <PageHeader title="Settings" subtitle="Messaging integrations" />
      <div className="notice info">Integration flows depend on the Meta platform (permissions, app review) and are not verified yet. A channel is only shown as connected when the backend reports it.</div>

      {status === 'loading' && <StateMessage kind="loading" message="Loading integrations…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load integrations. ${error.message}`} onRetry={reload} />}
      {status === 'ready' && data.items.length === 0 && <StateMessage message="No integrations are available." />}
      {status === 'ready' && (
        <div className="grid-2">
          {data.items.map((i) => {
            const Icon = ICON[i.channel];
            const canConnect = i.status === 'disconnected';
            const r = result[i.channel];
            return (
              <div key={i.channel} className="panel integration">
                <div className="integration-head">
                  <span className={`integration-icon channel-${i.channel}`}>{Icon && <Icon size={20} />}</span>
                  <h2>{CHANNEL_LABEL[i.channel]}</h2>
                  <span className={`int-status int-${i.status}`}>{STATUS_TEXT[i.status] ?? i.status}</span>
                </div>
                <p className="muted">{i.statusReason}</p>
                <dl>
                  <dt>Account</dt><dd>{i.accountLabel ?? '—'}</dd>
                  <dt>Last sync</dt><dd>{i.lastSyncAt ? formatDateTime(i.lastSyncAt) : '—'}</dd>
                </dl>
                {r && !r.ok && <div className="notice error" role="alert">{r.message}</div>}
                {r?.ok && <div className="notice ok">{r.url ? <>Continue in Meta: <a href={r.url} target="_blank" rel="noreferrer">authorise</a></> : 'Connection started.'}</div>}
                <button type="button" className="btn btn-primary" disabled={!canConnect || busy === i.channel} onClick={() => connect(i.channel)}>
                  {canConnect ? (busy === i.channel ? 'Connecting…' : 'Connect') : i.status === 'connected' ? 'Connected' : 'Connection unavailable'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
