import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { deleteOrder, listOrders, createOrder, getOrder, updateOrder, uploadOrderReferenceImage, DEMO_MODE } from '../services/api.js';
import useAsync from '../hooks/useAsync.js';
import useLive from '../hooks/useLive.js';
import { OPEN, isRushPlaceholder } from '../utils/format.js';
import { Modal, StateMessage } from '../components/UI.jsx';
import { COLUMNS, OrderAccordion, OrderDetails, RushBanner, OrderForm, statusFor } from '../components/Orders.jsx';
import '../css/Orders.css';


function OrderEditor({ orderId, onClose, onSaved }) {
  const { status, data, error, reload } = useAsync(() => (orderId ? getOrder(orderId) : Promise.resolve({})), [orderId]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  async function save(payload, picture) {
    setSaving(true); setSaveError(null);
    try {
      const saved = await (orderId ? updateOrder(orderId, payload) : createOrder(payload));
      let warning = null;
      if (picture) { // the order is saved first; then its picture is attached to it (the same id), so the card shows it as soon as the list reloads
        try { await uploadOrderReferenceImage(saved.id ?? orderId, picture); } catch (e) { warning = `The order was saved, but its picture could not be attached: ${e.message}`; }
      }
      onSaved(warning);
    } catch (e) { setSaveError(e); } finally { setSaving(false); }
  }

  return (
    <Modal title={orderId ? 'Edit order' : 'Add order'} onClose={onClose}>
      {status === 'loading' && <StateMessage kind="loading" message="Loading order…" />}
      {status === 'error' && <StateMessage kind="error" message={error.message} onRetry={reload} />}
      {status === 'ready' && (
        <>
          {saveError && <div className="notice error" role="alert">{saveError.message}</div>}
          <OrderForm initial={data} showStatus showPicture board={!orderId} serverErrors={saveError?.details} submitting={saving}
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
  const [deleting, setDeleting] = useState(null); // an order the owner is about to delete permanently: { order, busy, error }
  const [toast, setToast] = useState(null);
  const confirmDelete = async () => {
    const o = deleting.order; setDeleting({ order: o, busy: true, error: null });
    try { await deleteOrder(o.id); setDeleting(null); setOpenId(null); reload(); setToast(`${o.customerName}’s order was deleted.`); setTimeout(() => setToast(null), 4500); }
    catch (e) { setDeleting({ order: o, busy: false, error: e.message || 'The order could not be deleted.' }); } // the order stays exactly as it was
  };

  // /orders?edit=<id> (used by "Complete order details") opens the existing edit dialog.
  useEffect(() => {
    const id = params.get('edit');
    if (id) { setEditing(id === 'new' ? 'new' : id); setParams({}, { replace: true }); }
  }, [params, setParams]);

  // Every order is shown together, as an ordinary customer order: the page makes no distinction between sample and other orders.
  const { status, data, error, reload } = useAsync(() => listOrders({ pageSize: 100 }));
  useLive(['orders', 'payments'], reload);
  const [orders, setOrders] = useState([]); // local copy, so a drop moves the card at once and the API call follows
  useEffect(() => { if (data) setOrders(data.items.filter((o) => !isRushPlaceholder(o))); }, [data]); // the rush-capacity stand-in is shown by the banner, not as a customer's order
  // Real orders change on their own (a customer sends a new reference picture): look again every so often while the page is open and visible.
  useEffect(() => {
    if (DEMO_MODE) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 20000);
    return () => clearInterval(t);
  }, [reload]);

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
          <p className="od-sub">Hover an order to open it.</p>
          {data && <p className="od-pulse"><b>{stats.open}</b> open{stats.overdue > 0 && <> · <b className="is-late">{stats.overdue}</b> overdue</>} · <b>{stats.due}</b> awaiting payment</p>}
        </div>
        <div className="od-head-actions">
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
          <RushBanner />
          <OrderAccordion orders={shown} onOpen={setOpenId} onEdit={setEditing} />
          {search && shown.length === 0 && <p className="od-foot">No orders match “{search}”. <button type="button" className="od-clear" onClick={() => setSearch('')}>Clear search</button></p>}
        </>
      )}

      {selected && !editing && <OrderDetails order={selected} busy={busyId === selected.id} onClose={() => setOpenId(null)} onEdit={(id) => { setOpenId(null); setEditing(id); }}
        onStatus={(o, next) => { if (next === 'completed') { setOpenId(null); setConfirming(o); } else persist(o, next); }} onChanged={reload} onDelete={(o) => setDeleting({ order: o, busy: false, error: null })} />}

      {deleting && (
        <Modal variant="confirm" title="Delete this order?" onClose={() => !deleting.busy && setDeleting(null)}>
          <p>This order will be permanently removed. This action cannot be undone.</p>
          {deleting.error && <div className="notice error" role="alert">{deleting.error}</div>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setDeleting(null)} disabled={deleting.busy}>Cancel</button>
            <button type="button" className="btn btn-danger" onClick={confirmDelete} disabled={deleting.busy}>{deleting.busy ? 'Deleting…' : 'Delete order'}</button>
          </div>
        </Modal>
      )}
      {toast && <div className="od-toast" role="status">{toast}</div>}

      {confirming && (
        <Modal title="Mark as completed?" onClose={() => setConfirming(null)}>
          <p>Mark <strong>{confirming.customerName}</strong>’s order as completed? A completed order can’t be reopened.</p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setConfirming(null)}>Not yet</button>
            <button type="button" className="btn btn-primary" onClick={() => { const o = confirming; setConfirming(null); persist(o, 'completed'); }}>Mark completed</button>
          </div>
        </Modal>
      )}

      {editing && <OrderEditor orderId={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(warning) => { setEditing(null); reload(); if (warning) setNotice(warning); }} />}
    </section>
  );
}
