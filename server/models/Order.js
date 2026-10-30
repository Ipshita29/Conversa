import mongoose from 'mongoose';
import { ORDER_STATUSES, PAYMENT_STATUSES, SOURCES } from '../utils/validation.js';

const evidenceSchema = new mongoose.Schema({
  kind: { type: String, enum: ['screenshot_reference', 'transaction_reference', 'note'], required: true },
  reference: { type: String, required: true, maxlength: 500 },
  amount: { type: Number, min: 0, default: null },
  note: { type: String, maxlength: 500, default: null },
  addedAt: { type: Date, default: Date.now },
}, { _id: true });

// Scheduled start/end are computed by the workload engine on read; they are not stored, so they cannot go stale.
const orderSchema = new mongoose.Schema({
  customerName: { type: String, required: true, trim: true, maxlength: 120 },
  customerContact: { type: String, trim: true, maxlength: 120, default: null },
  source: { type: String, enum: SOURCES, default: 'manual' },
  item: { type: String, required: true, trim: true, maxlength: 200 },
  quantity: { type: Number, default: 1, min: 0, validate: (v) => v > 0 },
  customisation: { type: String, maxlength: 500, default: null },
  notes: { type: String, maxlength: 1000, default: null },
  prepTimeMinutes: { type: Number, default: null, min: 0 },
  price: { type: Number, default: null, min: 0 }, // the agreed total for the whole order (not per unit); null = not priced yet
  deadline: { type: Date, default: null },
  completedAt: { type: Date, default: null }, // when the order was moved to Completed (set by the server; null = unknown, e.g. completed before this was recorded)
  status: { type: String, enum: ORDER_STATUSES, default: 'pending' },
  paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unverified' },
  paymentEvidence: { type: [evidenceSchema], default: [] },
}, {
  timestamps: true,
  toJSON: {
    virtuals: false,
    versionKey: false,
    transform(doc, ret) {
      ret.id = String(ret._id);
      delete ret._id;
      if (ret.paymentEvidence) ret.paymentEvidence = ret.paymentEvidence.map(({ _id, ...e }) => ({ id: String(_id), ...e }));
      return ret;
    },
  },
});
orderSchema.index({ status: 1, deadline: 1 });

export default mongoose.models.Order || mongoose.model('Order', orderSchema);
