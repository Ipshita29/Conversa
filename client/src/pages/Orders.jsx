import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { listOrders, createOrder, getOrder, updateOrder } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import { OPEN } from '../utils/format.js';
import { DemoBadge, Modal, StateMessage } from '../components/UI.jsx';
import { COLUMNS, KanbanBoard, OrderDetails, OrderForm, statusFor } from '../components/Orders.jsx';
import '../css/Orders.css';


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
    <Modal title={orderId ? 'Edit order' : 'Add order'} onClose={onClose}>
      {status === 'loading' && <StateMessage kind="loading" message="Loading order…" />}
      {status === 'error' && <StateMessage kind="error" message={error.message} onRetry={reload} />}
      {status === 'ready' && (
        <>
          {saveError && <div className="notice error" role="alert">{saveError.message}</div>}
          <OrderForm initial={data} showStatus board={!orderId} serverErrors={saveError?.details} submitting={saving}
            submitLabel={orderId ? 'Save changes' : 'Add order'} onSubmit={save} onCancel={onClose} />
        </>
      )}
    </Modal>
  );
}

export default function Orders() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | orderId
  const [openId, setOpenId] = useState(null);   // the order whose details dialog is open
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);   // why a drop was refused
  const [confirming, setConfirming] = useState(null); // an order about to be marked completed (it can't be reopened)
  const [busyId, setBusyId] = useState(null);

  // /orders?edit=<id> (used by "Complete order details") opens the existing edit dialog.
  useEffect(() => {
    const id = params.get('edit');
    if (id) { setEditing(id === 'new' ? 'new' : id); setParams({}, { replace: true }); }
  }, [params, setParams]);

  const { status, data, error, reload } = useAsync(() => listOrders({ pageSize: 100 }));
  const [orders, setOrders] = useState([]); // local copy, so a drop moves the card at once and the API call follows
  useEffect(() => { if (data) setOrders(data.items); }, [data]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? orders.filter((o) => `${o.customerName} ${o.item}`.toLowerCase().includes(q)) : orders;
  }, [orders, search]);
  const stats = useMemo(() => ({
    open: orders.filter((o) => OPEN.includes(o.status)).length,
    overdue: orders.filter((o) => OPEN.includes(o.status) && o.deadline && new Date(o.deadline) < new Date()).length,
    due: orders.filter((o) => OPEN.includes(o.status) && o.paymentStatus !== 'verified').length,
  }), [orders]);

  // The only thing a move ever sends is { status }: payment is untouched.
  async function persist(order, next) {
    setActionError(null); setNotice(null); setBusyId(order.id);
    const before = orders;
    setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: next } : o)));
    try { await updateOrder(order.id, { status: next }); reload(); }
    catch (e) { setOrders(before); setActionError(`Couldn't move ${order.customerName}'s order: ${e.message}`); }
    finally { setBusyId(null); }
  }
  function onMove(order, col, verdict) {
    if (verdict && !verdict.ok) { setNotice(`${order.customerName}'s order can't go to ${COLUMNS.find((c) => c.key === col).title}. ${verdict.reason}`); return; }
    const next = statusFor(order, col);
    if (next === order.status) return;
    if (next === 'completed') setConfirming(order); else persist(order, next);
  }
  const selected = orders.find((o) => o.id === openId) ?? null;

  return (
    <section className="page orders">
      <header className="od-head">
        <div className="od-title">
          <h1>Orders</h1>
          <p className="od-sub">Drag an order to move it through your day.</p>
          {data && <p className="od-pulse"><b>{stats.open}</b> open{stats.overdue > 0 && <> · <b className="is-late">{stats.overdue}</b> overdue</>} · <b>{stats.due}</b> awaiting payment</p>}
        </div>
        <div className="od-head-actions">
          <DemoBadge />
          <label className="od-search"><Search size={16} aria-hidden="true" /><input type="search" placeholder="Search customer or product" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search orders" /></label>
          <button type="button" className="btn btn-primary od-add" onClick={() => setEditing('new')}><Plus size={16} aria-hidden="true" /> Add order</button>
        </div>
      </header>

      {actionError && <div className="notice error" role="alert">{actionError}</div>}
      {notice && <div className="notice info od-notice" role="status">{notice} <button type="button" className="od-clear" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {status === 'loading' && !data && <StateMessage kind="loading" message="Loading orders…" />}
      {status === 'error' && <StateMessage kind="error" message={`Couldn't load orders. ${error.message}`} onRetry={reload} />}
      {data && orders.length === 0 && (
        <StateMessage message="No orders yet."><button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Add your first order</button></StateMessage>
      )}
      {data && orders.length > 0 && (
        <>
          <KanbanBoard orders={shown} onMove={onMove} onOpen={setOpenId} />
          {search && shown.length === 0 && <p className="od-foot">No orders match “{search}”. <button type="button" className="od-clear" onClick={() => setSearch('')}>Clear search</button></p>}
        </>
      )}

      {selected && !editing && <OrderDetails order={selected} busy={busyId === selected.id} onClose={() => setOpenId(null)} onEdit={(id) => { setOpenId(null); setEditing(id); }}
        onStatus={(o, next) => { if (next === 'completed') { setOpenId(null); setConfirming(o); } else persist(o, next); }} onChanged={reload} />}

      {confirming && (
        <Modal title="Mark as completed?" onClose={() => setConfirming(null)}>
          <p>Mark <strong>{confirming.customerName}</strong>’s order as completed? A completed order can’t be reopened.</p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setConfirming(null)}>Not yet</button>
            <button type="button" className="btn btn-primary" onClick={() => { const o = confirming; setConfirming(null); persist(o, 'completed'); }}>Mark completed</button>
          </div>
        </Modal>
      )}

      {editing && <OrderEditor orderId={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </section>
  );
}
