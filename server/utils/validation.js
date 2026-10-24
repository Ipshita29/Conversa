// Order validation (docs/api-contract.md §2). Pure functions: returns { value, details }.
export const ORDER_STATUSES = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'];
export const PAYMENT_STATUSES = ['unverified', 'pending', 'verified', 'rejected'];
export const SOURCES = ['manual', 'whatsapp', 'instagram'];
export const OPEN_STATUSES = ['pending', 'confirmed', 'in_progress'];

const WRITABLE = ['price', 'customerName', 'customerContact', 'source', 'item', 'quantity', 'customisation', 'notes', 'prepTimeMinutes', 'deadline', 'status', 'paymentStatus'];
const READ_ONLY = ['id', '_id', 'createdAt', 'updatedAt', 'risk', 'paymentEvidence'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseIsoDate(v) {
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function validateOrderInput(body, { partial = false } = {}) {
  const details = [];
  const value = {};
  const add = (field, message) => details.push({ field, message });
  if (!isPlainObject(body)) return { value, details: [{ field: 'body', message: 'Request body must be a JSON object.' }] };

  for (const k of Object.keys(body)) {
    if (READ_ONLY.includes(k)) add(k, 'This field is read-only.');
    else if (!WRITABLE.includes(k)) add(k, 'Unknown field.');
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  for (const [field, label, max, required] of [['customerName', 'Customer name', 120, true], ['item', 'Item', 200, true]]) {
    if (has(field) || (required && !partial)) {
      const v = body[field];
      if (typeof v !== 'string' || !v.trim()) add(field, `${label} is required.`);
      else if (v.trim().length > max) add(field, `${label} must be at most ${max} characters.`);
      else value[field] = v.trim();
    }
  }
  for (const [field, max] of [['customerContact', 120], ['customisation', 500], ['notes', 1000]]) {
    if (has(field)) {
      const v = body[field];
      if (v === null) value[field] = null;
      else if (typeof v !== 'string') add(field, 'Must be a string or null.');
      else if (v.trim().length > max) add(field, `Must be at most ${max} characters.`);
      else value[field] = v.trim() || null;
    }
  }
  if (has('quantity')) {
    if (typeof body.quantity !== 'number' || !Number.isFinite(body.quantity) || body.quantity <= 0) add('quantity', 'Must be a positive number.');
    else value.quantity = body.quantity;
  }
  if (has('prepTimeMinutes')) {
    const v = body.prepTimeMinutes;
    if (v === null) value.prepTimeMinutes = null;
    else if (!Number.isInteger(v) || v < 0 || v > 60 * 24 * 30) add('prepTimeMinutes', 'Must be a whole number of minutes (0 or more), or null if unknown.');
    else value.prepTimeMinutes = v;
  }
  if (has('price')) {
    const v = body.price;
    if (v === null) value.price = null;
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000000) add('price', 'Must be a number of 0 or more (the total for the whole order), or null if not priced yet.');
    else value.price = Math.round(v * 100) / 100;
  }
  if (has('deadline')) {
    if (body.deadline === null) value.deadline = null;
    else {
      const d = parseIsoDate(body.deadline);
      if (!d) add('deadline', 'Must be an ISO 8601 timestamp with a timezone (e.g. 2026-10-21T14:00:00Z), or null if unknown.');
      else value.deadline = d;
    }
  }
  for (const [field, allowed] of [['source', SOURCES], ['status', ORDER_STATUSES], ['paymentStatus', PAYMENT_STATUSES]]) {
    if (has(field)) {
      if (!allowed.includes(body[field])) add(field, `Must be one of: ${allowed.join(', ')}.`);
      else value[field] = body[field];
    }
  }
  return { value, details };
}

export function validateEvidenceInput(body) {
  const details = [];
  if (!isPlainObject(body)) return { value: {}, details: [{ field: 'body', message: 'Request body must be a JSON object.' }] };
  const allowed = ['kind', 'reference', 'amount', 'note'];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) details.push({ field: k, message: 'Unknown field.' });
  const kinds = ['screenshot_reference', 'transaction_reference', 'note'];
  const value = { kind: body.kind ?? 'note' };
  if (!kinds.includes(value.kind)) details.push({ field: 'kind', message: `Must be one of: ${kinds.join(', ')}.` });
  if (typeof body.reference !== 'string' || !body.reference.trim() || body.reference.length > 500) details.push({ field: 'reference', message: 'Required, up to 500 characters (URL or reference id).' });
  else value.reference = body.reference.trim();
  if (body.amount !== undefined && body.amount !== null) {
    if (typeof body.amount !== 'number' || body.amount < 0) details.push({ field: 'amount', message: 'Must be a non-negative number.' });
    else value.amount = body.amount;
  }
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > 500) details.push({ field: 'note', message: 'Must be a string up to 500 characters.' });
    else value.note = body.note;
  }
  return { value, details };
}
