import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Plus, Search, Pencil } from 'lucide-react';
import { listOrders, createOrder, getOrder, updateOrder } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatMinutes, formatDateTime, formatMoney, isDemoOrder, OPEN, STATUS_LABEL } from '../utils/format.js';
import { ORDER_STATUSES } from '../utils/validateOrder.js';
import { ChannelBadge, DemoBadge, Modal, PaymentBadge, RiskBadge, StateMessage } from '../components/UI.jsx';
import { OrderForm } from '../components/Orders.jsx';
import '../css/Orders.css';

// "OVERDUE", "TODAY", "TOMORROW" or "IN 3 DAYS" for orders that are still open; nothing for finished ones.
function relativeDue(o) {
  if (!o.deadline || !OPEN.includes(o.status)) return null;
  const d = new Date(o.deadline);
  if (d < new Date()) return { text: 'Overdue', tone: 'late' };
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const n = Math.round((day(d) - day(new Date())) / 864e5);
  return { text: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`, tone: n <= 1 ? 'soon' : null };
}

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
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(() => (['all', 'pending', 'risk', 'completed'].includes(params.get('tab')) ? params.get('tab') : 'all'));
  const [search, setSearch] = useState('');
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
        <div><p className="eyebrow">Order management</p><h1>Orders &amp; deadlines</h1><p className="od-sub">Track commitments, spot delays, and keep every order moving.</p></div>
        <div className="od-head-actions"><DemoBadge /><button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> New order</button></div>
      </header>

      {data && (
        <dl className="od-summary" aria-label="Order summary">
          <div><dt>Total orders</dt><dd>{all.length}</dd></div>
          <div><dt>Open</dt><dd>{all.filter((o) => OPEN.includes(o.status)).length}</dd></div>
          <div className={count('risk') ? 'is-risk' : ''}><dt>At risk</dt><dd>{count('risk')}</dd></div>
          <div><dt>Completed</dt><dd>{count('completed')}</dd></div>
        </dl>
      )}

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
        <StateMessage message={all.length === 0 ? 'No orders yet.' : 'No orders match these filters.'}>
          {all.length === 0 && <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Create your first order</button>}
        </StateMessage>
      )}
      {items.length > 0 && (
        <ul className="od-list">
          <li className="od-cols" aria-hidden="true"><span>Customer &amp; product</span><span>Source</span><span>Deadline</span><span>Status</span><span /></li>
          {items.map((o) => {
            const open = OPEN.includes(o.status);
            const nd = open && (o.prepTimeMinutes === null || !o.deadline);
            const isOpen = openId === o.id;
            const late = open && o.risk === 'high';
            const rel = relativeDue(o);
            return (
              <li key={o.id} className={`od-item${isOpen ? ' is-open' : ''}${late ? ' is-late' : ''}${o.status === 'completed' ? ' is-done' : ''}`}>
                <button type="button" className="od-row" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : o.id)}>
                  <span className="od-who"><strong>{o.customerName}{isDemoOrder(o) && <span className="demo-tag">Demo</span>}</strong><span>{o.item}{o.quantity > 1 ? ` × ${o.quantity}` : ''}</span></span>
                  <span className="od-chan"><ChannelBadge channel={o.source} /></span>
                  <span className="od-due">{o.deadline ? <><span className="od-when">{formatDateTime(o.deadline)}</span>{rel && <span className={`od-rel${rel.tone ? ` is-${rel.tone}` : ''}`}>{rel.text}</span>}</> : <em>No deadline</em>}</span>
                  <span className="od-status"><span className={`od-st st-${o.status}`}><i aria-hidden="true" />{STATUS_LABEL[o.status] ?? o.status}</span>{(open || nd) && (o.risk === 'high' || o.risk === 'medium' || nd) && <RiskBadge risk={o.risk} needsDetails={nd} />}</span>
                  <span className="od-more"><span className="od-more-label">{isOpen ? 'Hide' : 'Details'}</span><ChevronDown size={15} className="od-chev" aria-hidden="true" /></span>
                </button>
                {isOpen && (
                  <div className="od-detail">
                    <dl>
                      <div><dt>Preparation</dt><dd>{o.prepTimeMinutes === null ? 'Not set' : formatMinutes(o.prepTimeMinutes)}</dd></div>
                      <div><dt>Price</dt><dd>{o.price == null ? 'Not set' : formatMoney(o.price)}</dd></div>
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
      {data && all.length > 0 && <p className="od-foot">Showing {items.length} of {all.length} {all.length === 1 ? 'order' : 'orders'}{(tab !== 'all' || search) && <> · <button type="button" className="od-clear" onClick={() => { setTab('all'); setSearch(''); }}>Clear filters</button></>}</p>}

      {editing && <OrderEditor orderId={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </section>
  );
}
