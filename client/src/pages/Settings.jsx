import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, MessageCircle, Camera } from 'lucide-react';
import { registerChannelWebhook, getChannelDiagnostics, testChannelConnection, completeWhatsAppSignup, disconnectIntegration, getIntegrations, getWhatsAppSignup, DEMO_MODE } from '../services/api.js';
import { launchWhatsAppSignup } from '../services/metaSignup.js';
import useAsync from '../hooks/useAsync.js';
import useLive from '../hooks/useLive.js';
import { CHANNEL_LABEL } from '../utils/format.js';
import { PageHeader } from '../components/Layout.jsx';
import { StateMessage } from '../components/UI.jsx';
import '../css/Layout.css';

// The five states an account can be in. "connected" is only ever shown after Meta itself accepted the credentials.
const STATE = { not_connected: 'Not connected', connecting: 'Connecting…', connected: 'Connected', needs_attention: 'Needs attention', expired: 'Expired', demo: 'Demo' };
const ICON = { whatsapp: MessageCircle };
const REQUIRES = {
  whatsapp: ['A WhatsApp Business Account and a phone number that is not already on the regular WhatsApp app (or is migrated to the Business Platform).', 'A Meta app with the WhatsApp product, the whatsapp_business_messaging permission, and Embedded Signup configured. Business verification is needed to message customers at scale.'],
};

function Copyable({ label, value }) {
  const [done, setDone] = useState(false);
  if (!value) return <><dt>{label}</dt><dd className="muted">Set SERVER_URL on the server to see this address.</dd></>;
  return <><dt>{label}</dt><dd className="int-url"><code>{value}</code><button type="button" className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }} aria-label={`Copy ${label}`}>{done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}</button></dd></>;
}

const when = (d) => (d ? new Date(d).toLocaleString() : 'never');
// What the connection has actually done, and a Test connection that asks Meta and the public webhook address for real.
function Diagnostics({ channel, item }) {
  const diag = useAsync(() => getChannelDiagnostics(channel), [channel]);
  useLive(['messages'], diag.reload);
  const [test, setTest] = useState({ status: 'idle', data: null, error: null });
  const run = async () => { setTest({ status: 'running', data: null, error: null }); try { setTest({ status: 'done', data: await testChannelConnection(channel), error: null }); } catch (e) { setTest({ status: 'done', data: null, error: e.message }); } };
  const register = async () => { setTest({ status: 'running', data: null, error: null }); try { setTest({ status: 'done', data: await registerChannelWebhook(channel), error: null }); diag.reload(); } catch (e) { setTest({ status: 'done', data: null, error: e.message }); } };
  const d = diag.data;
  return (
    <details className="int-diag" open>
      <summary>Connection diagnostics</summary>
      <dl>
        <dt>Provider</dt><dd>Meta WhatsApp Cloud API</dd>
        <dt>Status</dt><dd>{STATE[item.state] ?? item.state}{item.statusReason ? <span className="muted"> · {item.statusReason}</span> : null}</dd>
        {d && <>
          <dt>Webhook verified by Meta</dt><dd>{d.webhook.verifiedAt ? when(d.webhook.verifiedAt) : 'not yet'}</dd>
          <dt>Last webhook received</dt><dd>{when(d.webhook.lastReceivedAt)}</dd>
          <dt>Last incoming message</dt><dd>{when(d.lastIncomingAt)}</dd>
          <dt>Last outgoing message</dt><dd>{when(d.lastOutgoingAt)}</dd>
          <dt>Last webhook error</dt><dd>{d.webhook.lastError ? `${when(d.webhook.lastError.at)}: ${d.webhook.lastError.message}` : 'none'}</dd>
          <dt>Picture downloads</dt><dd>{d.media.state === 'none' ? 'no picture received yet' : d.media.state === 'downloaded' ? `last one downloaded (${when(d.media.lastPictureAt)})` : `last one failed: ${d.media.error ?? 'unknown reason'}`}</dd>
        </>}
      </dl>
      {channel === 'whatsapp' && <button type="button" className="btn" onClick={register} disabled={test.status === 'running'} title="Points Meta at this server's public address and subscribes the app">Register webhook with Meta</button>}
      {channel === 'whatsapp' && <button type="button" className="btn" onClick={run} disabled={test.status === 'running'}>{test.status === 'running' ? 'Testing…' : 'Test connection'}</button>}
      {test.error && <div className="notice error" role="alert">{test.error}</div>}
      {test.data && (
        <ul className="int-steps" aria-label="Test results">
          {test.data.steps.map((s) => <li key={s.id} className={s.ok === true ? 'is-ok' : s.ok === false ? 'is-bad' : 'is-unknown'}><b>{s.ok === true ? '✓' : s.ok === false ? '✗' : '?'} {s.label}</b><span>{s.detail}</span></li>)}
        </ul>
      )}
    </details>
  );
}

export default function Settings() {
  const { status, data, error, reload } = useAsync(getIntegrations);
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState({});


  const fail = (channel, e) => setResult((x) => ({ ...x, [channel]: { ok: false, message: e.message } }));
  async function connect(channel) {
    setBusy(channel); setResult((x) => ({ ...x, [channel]: null }));
    try {
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
      <PageHeader title="Settings" subtitle="Connect WhatsApp once, then manage every conversation from the Inbox." />
      {DEMO_MODE && <div className="notice info" role="note">Demo mode: Conversa is running on sample data in this browser, so accounts cannot be connected here. To connect real accounts, run the backend and set <code>VITE_DEMO_MODE=false</code>. Demo data is never deleted or mixed with real data.</div>}

      {status === 'loading' && <StateMessage kind="loading" message="Loading integrations…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load integrations. ${error.message}`} onRetry={reload} />}
      {status === 'ready' && (
        <div className="grid-2 int-one">
          {data.items.filter((i) => i.channel === 'whatsapp').map((i) => {
            const Icon = ICON[i.channel]; const state = DEMO_MODE ? 'demo' : (i.state ?? 'not_connected'); const r = result[i.channel];
            const connected = state === 'connected'; const ready = i.connect?.ready !== false; // false = the server lacks a setting the sign-in needs (named in the message above)
            const canConnect = !DEMO_MODE && ready && ['not_connected', 'connecting', 'needs_attention', 'expired'].includes(state);
            return (
              <div key={i.channel} className="panel integration">
                <div className="integration-head">
                  <span className={`integration-icon channel-${i.channel}`}>{Icon && <Icon size={20} />}</span>
                  <h2>WhatsApp Business</h2>
                  <span className={`int-status int-${state === 'connected' && i.webhook?.health === 'unverified' ? 'needs_attention' : state}`}>{state === 'connected' && i.webhook?.health === 'unverified' ? 'Token valid · webhook not verified' : STATE[state] ?? state}</span>
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
                    {busy === i.channel ? 'Working…' : connected ? 'Connected' : state === 'needs_attention' || state === 'expired' ? 'Reconnect' : state === 'connecting' ? 'Try again' : 'Connect WhatsApp'}
                  </button>
                  {!DEMO_MODE && (connected || state === 'needs_attention' || state === 'expired') && i.source === 'oauth' && <button type="button" className="btn" disabled={busy === i.channel} onClick={() => disconnect(i.channel)}>Disconnect</button>}
                </div>
                {!DEMO_MODE && <Diagnostics channel={i.channel} item={i} />}
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
          </dl>
        </div>
      )}
    </section>
  );
}
