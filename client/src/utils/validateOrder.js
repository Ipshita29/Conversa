// Validation rules from docs/api-contract.md §2. Shared by the order form and the demo mock backend.
export const ORDER_STATUSES = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'];
export const PAYMENT_STATUSES = ['unverified', 'pending', 'verified', 'rejected'];
export const SOURCES = ['manual', 'whatsapp', 'instagram'];

export function validateOrder(o, { partial = false } = {}) {
  const details = [];
  const add = (field, message) => details.push({ field, message });
  const has = (k) => Object.prototype.hasOwnProperty.call(o, k);

  for (const [field, label, max] of [['customerName', 'Customer name', 120], ['item', 'Item', 200]]) {
    if (!partial || has(field)) {
      const v = o[field];
      if (typeof v !== 'string' || !v.trim()) add(field, `${label} is required.`);
      else if (v.trim().length > max) add(field, `${label} must be at most ${max} characters.`);
    }
  }
  if (has('quantity') && !(typeof o.quantity === 'number' && o.quantity > 0)) add('quantity', 'Must be a positive number.');
  if (has('prepTimeMinutes') && o.prepTimeMinutes !== null && !(Number.isInteger(o.prepTimeMinutes) && o.prepTimeMinutes >= 0)) {
    add('prepTimeMinutes', 'Must be a whole number of minutes (0 or more), or empty if unknown.');
  }
  if (has('price') && o.price !== null && !(typeof o.price === 'number' && Number.isFinite(o.price) && o.price >= 0)) add('price', 'Must be 0 or more, or empty if not priced yet.');
  if (has('deadline') && o.deadline !== null && Number.isNaN(Date.parse(o.deadline))) add('deadline', 'Must be a valid date and time, or empty if unknown.');
  if (has('status') && !ORDER_STATUSES.includes(o.status)) add('status', `Must be one of: ${ORDER_STATUSES.join(', ')}.`);
  if (has('paymentStatus') && !PAYMENT_STATUSES.includes(o.paymentStatus)) add('paymentStatus', `Must be one of: ${PAYMENT_STATUSES.join(', ')}.`);
  if (has('source') && !SOURCES.includes(o.source)) add('source', `Must be one of: ${SOURCES.join(', ')}.`);
  return details;
}
