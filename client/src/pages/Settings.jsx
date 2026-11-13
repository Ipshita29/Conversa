import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, MessageCircle, Camera } from 'lucide-react';
import { completeWhatsAppSignup, disconnectIntegration, getIntegrations, getWhatsAppSignup, startInstagramOAuth, DEMO_MODE } from '../services/api.js';
import { launchWhatsAppSignup } from '../services/metaSignup.js';
import useAsync from '../hooks/useAsync.js';
import { CHANNEL_LABEL } from '../utils/format.js';
import { PageHeader } from '../components/Layout.jsx';
import { StateMessage } from '../components/UI.jsx';
import '../css/Layout.css';

// The five states an account can be in. "connected" is only ever shown after Meta itself accepted the credentials.
const STATE = { not_connected: 'Not connected', connecting: 'Connecting…', connected: 'Connected', needs_attention: 'Needs attention', expired: 'Expired', demo: 'Demo' };
const ICON = { whatsapp: MessageCircle, instagram: Camera };
const REQUIRES = {
  whatsapp: ['A WhatsApp Business Account and a phone number that is not already on the regular WhatsApp app (or is migrated to the Business Platform).', 'A Meta app with the WhatsApp product, the whatsapp_business_messaging permission, and Embedded Signup configured. Business verification is needed to message customers at scale.'],
  instagram: ['An Instagram professional account (business or creator). A personal account cannot use the messaging API.', 'A Meta app with “API setup with Unified login” (or Instagram Login) and the instagram_manage_messages permission. Accounts you do not own need Advanced Access (app review); until then only people with a role on the app can connect.'],
};

function Copyable({ label, value }) {
  const [done, setDone] = useState(false);
  if (!value) return <><dt>{label}</dt><dd className="muted">Set SERVER_URL on the server to see this address.</dd></>;
  return <><dt>{label}</dt><dd className="int-url"><code>{value}</code><button type="button" className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }} aria-label={`Copy ${label}`}>{done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}</button></dd></>;
}

export default function Settings() {
  const { status, data, error, reload } = useAsync(getIntegrations);
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState({});

  // Coming back from Instagram's login: ?integration=instagram&result=connected|cancelled|error
  useEffect(() => {
    const ch = params.get('integration'); const r = params.get('result');
    if (!ch || !r) return;
    setResult((x) => ({ ...x, [ch]: r === 'connected' ? { ok: true, message: 'Instagram is connected.' } : { ok: false, message: r === 'cancelled' ? 'Connecting was cancelled.' : (params.get('reason') || 'Instagram could not be connected.') } }));
    setParams({}, { replace: true }); reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (channel, e) => setResult((x) => ({ ...x, [channel]: { ok: false, message: e.message } }));
  async function connect(channel) {
    setBusy(channel); setResult((x) => ({ ...x, [channel]: null }));
    try {
      if (channel === 'instagram') { const { url } = await startInstagramOAuth(); window.location.assign(url); return; }
      const cfg = await getWhatsAppSignup();
      if (!cfg.ready) throw new Error(`WhatsApp sign-up is not set up on the server yet. Missing: ${cfg.missing.join(', ')}.`);
      const out = await launchWhatsAppSignup(cfg);
      await completeWhatsAppSignup(out);
      setResult((x) => ({ ...x, whatsapp: { ok: true, message: 'WhatsApp is connected.' } })); reload();
    } catch (e) { fail(channel, e); } finally { setBusy(null); }
  }
  async function disconnect(channel) {
    if (!window.confirm(`Disconnect ${CHANNEL_LABEL[channel]}? New messages will stop arriving. Your existing conversations stay in the Inbox.`)) return;
    setBusy(channel);
    try { await disconnectIntegration(channel); setResult((x) => ({ ...x, [channel]: { ok: true, message: 'Disconnected.' } })); reload(); } catch (e) { fail(channel, e); } finally { setBusy(null); }
  }

  return (
    <section className="page settings">
      <PageHeader title="Settings" subtitle="Connect WhatsApp and Instagram once, then manage every conversation from the Inbox." />
      {DEMO_MODE && <div className="notice info" role="note">Demo mode: Conversa is running on sample data in this browser, so accounts cannot be connected here. To connect real accounts, run the backend and set <code>VITE_DEMO_MODE=false</code>. Demo data is never deleted or mixed with real data.</div>}

      {status === 'loading' && <StateMessage kind="loading" message="Loading integrations…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load integrations. ${error.message}`} onRetry={reload} />}
      {status === 'ready' && (
        <div className="grid-2">
          {data.items.map((i) => {
            const Icon = ICON[i.channel]; const state = DEMO_MODE ? 'demo' : (i.state ?? 'not_connected'); const r = result[i.channel];
            const connected = state === 'connected'; const ready = i.connect?.ready !== false; // false = the server lacks a setting the sign-in needs (named in the message above)
            const canConnect = !DEMO_MODE && ready && ['not_connected', 'connecting', 'needs_attention', 'expired'].includes(state);
            return (
              <div key={i.channel} className="panel integration">
                <div className="integration-head">
                  <span className={`integration-icon channel-${i.channel}`}>{Icon && <Icon size={20} />}</span>
                  <h2>{i.channel === 'whatsapp' ? 'WhatsApp Business' : 'Instagram'}</h2>
                  <span className={`int-status int-${state}`}>{STATE[state] ?? state}</span>
                </div>
                <p className="muted">{state === 'demo' ? 'Sample conversations only.' : i.statusReason ?? (connected ? 'Messages arrive in your Inbox and replies are sent from it.' : 'Not connected yet.')}</p>
                <dl>
                  <dt>{i.channel === 'whatsapp' ? 'Business number' : 'Account'}</dt><dd>{connected ? (i.accountLabel ?? '—') : '—'}</dd>
                  {i.source && connected && <><dt>Connected via</dt><dd>{i.source === 'oauth' ? 'Meta sign-in' : 'Server settings'}</dd></>}
                  {i.expiresAt && connected && <><dt>Access valid until</dt><dd>{new Date(i.expiresAt).toLocaleDateString()} <span className="muted">(renewed automatically)</span></dd></>}
                </dl>
                {r && <div className={`notice ${r.ok ? 'ok' : 'error'}`} role={r.ok ? 'status' : 'alert'}>{r.message}</div>}
                <div className="int-actions">
                  <button type="button" className="btn btn-primary" disabled={!canConnect || busy === i.channel} onClick={() => connect(i.channel)}>
                    {busy === i.channel ? 'Working…' : connected ? 'Connected' : state === 'needs_attention' || state === 'expired' ? 'Reconnect' : state === 'connecting' ? 'Try again' : `Connect ${i.channel === 'whatsapp' ? 'WhatsApp' : 'Instagram'}`}
                  </button>
                  {!DEMO_MODE && (connected || state === 'needs_attention' || state === 'expired') && i.source === 'oauth' && <button type="button" className="btn" disabled={busy === i.channel} onClick={() => disconnect(i.channel)}>Disconnect</button>}
                </div>
                {!DEMO_MODE && !connected && (
                  <details className="int-needs"><summary>What Meta requires</summary><ul>{REQUIRES[i.channel].map((t) => <li key={t}>{t}</li>)}</ul></details>
                )}
              </div>
            );
          })}
        </div>
      )}

      {status === 'ready' && !DEMO_MODE && (
        <div className="panel integration" style={{ marginTop: '1rem' }}>
          <h2>Webhook addresses</h2>
          <p className="muted">Register these in your Meta app so incoming messages reach Conversa. They must be public HTTPS addresses.</p>
          <dl className="int-webhooks">
            <Copyable label="WhatsApp callback URL" value={data.webhooks?.whatsapp} />
            <Copyable label="Instagram callback URL" value={data.webhooks?.instagram} />
            <Copyable label="Instagram OAuth redirect URI" value={data.webhooks?.instagramOAuthRedirect} />
          </dl>
        </div>
      )}
    </section>
  );
}
