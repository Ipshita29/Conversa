import mongoose from 'mongoose';

// The unique (channel, externalId) index makes webhook retries idempotent (no duplicate processing).
const messageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  channel: { type: String, enum: ['whatsapp', 'instagram'], required: true },
  externalId: { type: String, required: true },
  direction: { type: String, enum: ['inbound'], default: 'inbound' },
  text: { type: String, default: null },
  messageType: { type: String, default: 'text' },
  receivedAt: { type: Date, default: Date.now },
  // An image the customer sent (e.g. a payment screenshot), kept on disk like payment proofs. paymentId = the record filed from it.
  attachment: { type: { file: String, contentType: String, size: Number, sha256: String }, default: null, _id: false },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  readAt: { type: Date, default: null }, // null = unread
  isDemo: { type: Boolean, default: false },
}, { timestamps: true });
messageSchema.index({ channel: 1, externalId: 1 }, { unique: true });

export default mongoose.models.Message || mongoose.model('Message', messageSchema);
