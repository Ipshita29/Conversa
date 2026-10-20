import { useMemo, useState } from 'react';
import { Plus, Search, Pencil } from 'lucide-react';
import { listOrders, createOrder, getOrder, updateOrder } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { formatMinutes, formatDateTime, STATUS_LABEL, PAYMENT_LABEL, CHANNEL_LABEL } from '../utils/format.js';
import { ORDER_STATUSES, PAYMENT_STATUSES, SOURCES } from '../utils/validateOrder.js';
import PageHeader from '../components/PageHeader.jsx';
import StateMessage from '../components/StateMessage.jsx';
import Modal from '../components/Modal.jsx';
import OrderForm from '../components/OrderForm.jsx';
import { RiskBadge, PaymentBadge, ChannelBadge } from '../components/Badge.jsx';
import '../css/Orders.css';

function OrderEditor({ orderId, onClose, onSaved }) {
  const { status, data, error, reload } = useAsync(() => (orderId ? getOrder(orderId) : Promise.resolve({})), [orderId]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  async function save(payload) {
    setSaving(true);
    setSaveError(null);
    try {
      await (orderId ? updateOrder(orderId, payload) : createOrder(payload));
      onSaved();
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
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
  const [filters, setFilters] = useState({ status: '', paymentStatus: '', source: '' });
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | orderId
  const [actionError, setActionError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const { status, data, error, reload } = useAsync(() => listOrders({ ...filters, pageSize: 100 }), [filters.status, filters.paymentStatus, filters.source]);

  const items = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return q ? data.items.filter((o) => `${o.customerName} ${o.item} ${o.id}`.toLowerCase().includes(q)) : data.items;
  }, [data, search]);

  async function changeStatus(order, next) {
    setBusyId(order.id);
    setActionError(null);
    try {
      await updateOrder(order.id, { status: next });
      reload();
    } catch (e) {
      setActionError(`Couldn't update ${order.customerName}'s order: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  }

  const setFilter = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const filtering = filters.status || filters.paymentStatus || filters.source || search;

  return (
    <section className="page orders">
      <PageHeader title="Orders" subtitle="Track every order, its deadline and payment.">
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> New order</button>
      </PageHeader>

      <div className="panel">
        <div className="toolbar">
          <label className="search"><Search size={16} aria-hidden="true" /><input type="search" placeholder="Search customer or item…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search orders" /></label>
          <select value={filters.status} onChange={setFilter('status')} aria-label="Filter by status">
            <option value="">All statuses</option>{ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          <select value={filters.paymentStatus} onChange={setFilter('paymentStatus')} aria-label="Filter by payment">
            <option value="">All payments</option>{PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{PAYMENT_LABEL[s]}</option>)}
          </select>
          <select value={filters.source} onChange={setFilter('source')} aria-label="Filter by channel">
            <option value="">All channels</option>{SOURCES.map((s) => <option key={s} value={s}>{CHANNEL_LABEL[s]}</option>)}
          </select>
        </div>

        {actionError && <div className="notice error" role="alert">{actionError}</div>}
        {status === 'loading' && !data && <StateMessage kind="loading" message="Loading orders…" />}
        {status === 'error' && <StateMessage kind="error" message={`Couldn't load orders. ${error.message}`} onRetry={reload} />}
        {data && items.length === 0 && (
          <StateMessage message={filtering ? 'No orders match your filters.' : 'No orders yet.'}>
            {!filtering && <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Create your first order</button>}
          </StateMessage>
        )}
        {data && items.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Customer</th><th>Channel</th><th>Item</th><th>Qty</th><th>Prep</th><th>Deadline</th><th>Risk</th><th>Status</th><th>Payment</th><th /></tr></thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id} className={o.risk ? `row-${o.risk}` : ''}>
                    <td><strong>{o.customerName}</strong></td>
                    <td><ChannelBadge channel={o.source} /></td>
                    <td>{o.item}</td>
                    <td>{o.quantity}</td>
                    <td>{o.prepTimeMinutes === null ? <span className="muted">Unknown</span> : formatMinutes(o.prepTimeMinutes)}</td>
                    <td>{o.deadline ? formatDateTime(o.deadline) : <span className="muted">No deadline</span>}</td>
                    <td><RiskBadge risk={o.risk} /></td>
                    <td>
                      <select className={`status-select status-${o.status}`} value={o.status} disabled={busyId === o.id} onChange={(e) => changeStatus(o, e.target.value)} aria-label={`Status for ${o.customerName}`}>
                        {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                      </select>
                    </td>
                    <td><PaymentBadge status={o.paymentStatus} /></td>
                    <td><button type="button" className="btn btn-sm" onClick={() => setEditing(o.id)}><Pencil size={13} /> Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <p className="muted table-foot">Showing {items.length} of {data.total} orders</p>}
      </div>

      {editing && <OrderEditor orderId={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </section>
  );
}
