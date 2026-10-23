import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Plus, Search, Pencil } from 'lucide-react';
import { listOrders, createOrder, getOrder, updateOrder } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatMinutes, formatDateTime, isDemoOrder, OPEN, STATUS_LABEL } from '../utils/format.js';
import { ORDER_STATUSES } from '../utils/validateOrder.js';
import DemoBadge from '../components/DemoBadge.jsx';
import StateMessage from '../components/StateMessage.jsx';
import Modal from '../components/Modal.jsx';
import OrderForm from '../components/OrderForm.jsx';
import { RiskBadge, PaymentBadge, StatusBadge, ChannelBadge } from '../components/Badge.jsx';
import '../css/Orders.css';

const TABS = [['all', 'All'], ['pending', 'Pending'], ['risk', 'At risk'], ['completed', 'Completed']];
const matches = (o, tab) => (tab === 'all' ? true : tab === 'pending' ? ['pending', 'confirmed', 'in_progress'].includes(o.status) : tab === 'completed' ? o.status === 'completed'
  : OPEN.includes(o.status) && (o.risk === 'high' || o.risk === 'medium'));

function OrderEditor({ orderId, onClose, onSaved }) {
  const { status, data, error, reload } = useAsync(() => (orderId ? getOrder(orderId) : Promise.resolve({})), [orderId]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  async function save(payload) {
    setSaving(true); setSaveError(null);
    try { await (orderId ? updateOrder(orderId, payload) : createOrder(payload)); onSaved(); }
    catch (e) { setSaveError(e); } finally { setSaving(false); }
  }

  return (
    <Modal title={orderId ? 'Edit order' : 'New order'} onClose={onClose}>
      {status === 'loading' && <StateMessage kind="loading" message="Loading order…" />}
      {status === 'error' && <StateMessage kind="error" message={error.message} onRetry={reload} />}
      {status === 'ready' && (
        <>
          {saveError && <div className="notice error" role="alert">{saveError.message}</div>}
          <OrderForm initial={data} showStatus={Boolean(orderId)} serverErrors={saveError?.details} submitting={saving}
            submitLabel={orderId ? 'Save changes' : 'Create order'} onSubmit={save} onCancel={onClose} />
        </>
      )}
    </Modal>
  );
}

export default function Orders() {
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(null); // null | 'new' | orderId
  const [openId, setOpenId] = useState(null);   // the row whose details are expanded

  // /orders?edit=<id> (used by "Complete order details") opens the existing edit dialog.
  useEffect(() => {
    const id = params.get('edit');
    if (id) { setEditing(id); setParams({}, { replace: true }); }
  }, [params, setParams]);
  const [actionError, setActionError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const { status, data, error, reload } = useAsync(() => listOrders({ pageSize: 100 }));
  const all = data?.items ?? [];
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((o) => matches(o, tab) && (!q || `${o.customerName} ${o.item}`.toLowerCase().includes(q)));
  }, [all, tab, search]);
  const count = (t) => all.filter((o) => matches(o, t)).length;

  async function changeStatus(order, next) {
    setBusyId(order.id); setActionError(null);
    try { await updateOrder(order.id, { status: next }); reload(); }
    catch (e) { setActionError(`Couldn't update ${order.customerName}'s order: ${e.message}`); }
    finally { setBusyId(null); }
  }

  return (
    <section className="page orders">
      <header className="od-head">
        <div><p className="eyebrow">Orders</p><h1>Every order, in one place.</h1></div>
        <div className="od-head-actions"><DemoBadge /><button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> New order</button></div>
      </header>

      <div className="od-bar">
        <div className="od-tabs" role="tablist" aria-label="Show orders">
          {TABS.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} className={`od-tab${tab === value ? ' is-on' : ''}`} onClick={() => setTab(value)}>{label}{data && <b>{count(value)}</b>}</button>
          ))}
        </div>
        <label className="od-search"><Search size={16} aria-hidden="true" /><input type="search" placeholder="Search customer or product" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search orders" /></label>
      </div>

      {actionError && <div className="notice error" role="alert">{actionError}</div>}
      {status === 'loading' && !data && <StateMessage kind="loading" message="Loading orders…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load orders. ${error.message}`} onRetry={reload} />}
      {data && items.length === 0 && (
        <StateMessage message={all.length === 0 ? 'No orders yet.' : 'No orders match.'}>
          {all.length === 0 && <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Create your first order</button>}
        </StateMessage>
      )}
      {items.length > 0 && (
        <ul className="od-list">
          {items.map((o) => {
            const open = OPEN.includes(o.status);
            const nd = open && (o.prepTimeMinutes === null || !o.deadline);
            const isOpen = openId === o.id;
            const late = open && o.risk === 'high';
            return (
              <li key={o.id} className={`od-item${isOpen ? ' is-open' : ''}${late ? ' is-late' : ''}${o.status === 'completed' ? ' is-done' : ''}`}>
                <button type="button" className="od-row" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : o.id)}>
                  <span className="od-who"><strong>{o.customerName}{isDemoOrder(o) && <span className="demo-tag">Demo</span>}</strong><span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></span>
                  <span className="od-chan"><ChannelBadge channel={o.source} /></span>
                  <span className="od-due">{o.deadline ? formatDateTime(o.deadline) : <em>No deadline</em>}</span>
                  <span className="od-status"><StatusBadge status={o.status} />{(open || nd) && (o.risk === 'high' || o.risk === 'medium' || nd) && <RiskBadge risk={o.risk} needsDetails={nd} />}</span>
                  <ChevronDown size={16} className="od-chev" aria-hidden="true" />
                </button>
                {isOpen && (
                  <div className="od-detail">
                    <dl>
                      <div><dt>Preparation</dt><dd>{o.prepTimeMinutes === null ? 'Not set' : formatMinutes(o.prepTimeMinutes)}</dd></div>
                      <div><dt>Payment</dt><dd><PaymentBadge status={o.paymentStatus} /></dd></div>
                      {o.customerContact && <div><dt>Contact</dt><dd>{o.customerContact}</dd></div>}
                      {o.customisation && <div><dt>Customisation</dt><dd>{o.customisation}</dd></div>}
                      {o.notes && !isDemoOrder(o) && <div><dt>Notes</dt><dd>{o.notes}</dd></div>}
                    </dl>
                    <div className="od-actions">
                      <label className="od-statuspick"><span>Status</span>
                        <select className={`status-select status-${o.status}`} value={o.status} disabled={busyId === o.id} onChange={(e) => changeStatus(o, e.target.value)} aria-label={`Status for ${o.customerName}`}>
                          {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select></label>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(o.id)} aria-label={`Edit ${o.customerName}'s order`}><Pencil size={13} aria-hidden="true" /> Edit</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data && <p className="muted od-foot">{items.length} of {all.length} orders</p>}

      {editing && <OrderEditor orderId={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </section>
  );
}
