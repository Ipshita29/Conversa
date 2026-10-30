import mongoose from 'mongoose';
import { METHODS, PAYMENT_RECORD_STATUSES, PAYMENT_SOURCES } from '../services/paymentLogic.js';

const historySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  action: { type: String, required: true, maxlength: 40 },
  by: { type: String, maxlength: 80, default: null },
  note: { type: String, maxlength: 500, default: null },
}, { _id: false });

// One row per payment event. Many per order (deposit, instalments, COD collection, refunds). Unverified extraction results live here
// as status "pending" and are kept apart from confirmed money by that status alone: only "confirmed" rows count as received.
const paymentSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  kind: { type: String, enum: ['payment', 'refund'], default: 'payment' },
  refundOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  amount: { type: Number, required: true, min: 0.01 },
  method: { type: String, enum: METHODS, required: true },
  status: { type: String, enum: PAYMENT_RECORD_STATUSES, default: 'pending' },
  transactionId: { type: String, maxlength: 64, default: null },
  transactionKey: { type: String, default: null }, // upper-cased, no spaces: what duplicates are checked on
  paidAt: { type: Date, default: null },
  source: { type: String, enum: PAYMENT_SOURCES, default: 'manual' },
  notes: { type: String, maxlength: 500, default: null },
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
  messageId: { type: String, default: null },
  // The original screenshot is kept on disk under a random name (never served as a static file); only its metadata is here.
  proof: { type: { file: String, contentType: String, size: Number, originalName: String, sha256: String }, default: null, _id: false },
  proofHash: { type: String, default: null }, // SHA-256 of the screenshot: the same image cannot be filed twice, from Inbox or Payments
  extraction: { type: { method: String, confidence: Number, needsReview: Boolean, issues: [String], recipient: String, model: String, extractedAt: Date, edited: Boolean }, default: null, _id: false },
  review: { type: { by: String, at: Date, note: String, confirmedAmount: Number, mode: String }, default: null, _id: false },
  history: { type: [historySchema], default: [] },
  isDemo: { type: Boolean, default: false },
}, {
  timestamps: true,
  toJSON: {
    versionKey: false,
    transform(doc, ret) {
      ret.id = String(ret._id);
      ret.orderId = String(ret.order);
      ret.conversationId = ret.conversation ? String(ret.conversation) : null;
      ret.refundOf = ret.refundOf ? String(ret.refundOf) : null;
      if (ret.proof) ret.proof = { contentType: ret.proof.contentType, size: ret.proof.size };
      delete ret._id; delete ret.order; delete ret.conversation; delete ret.transactionKey; delete ret.proofHash;
      return ret;
    },
  },
});
// A transaction can be recorded once while it is pending or confirmed. A rejected record frees the ID so a corrected entry can be made.
paymentSchema.index({ proofHash: 1 }, { unique: true, partialFilterExpression: { proofHash: { $type: 'string' }, status: { $in: ['pending', 'confirmed'] } } });
paymentSchema.index({ transactionKey: 1 }, { unique: true, partialFilterExpression: { transactionKey: { $type: 'string' }, status: { $in: ['pending', 'confirmed'] } } });

export default mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
