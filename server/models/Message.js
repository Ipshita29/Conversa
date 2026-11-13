import mongoose from 'mongoose';

// The unique (channel, externalId) index makes webhook retries idempotent (no duplicate processing).
const messageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  channel: { type: String, enum: ['whatsapp', 'instagram'], required: true },
  externalId: { type: String, required: true },
  direction: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' }, // outbound = the business's own reply (demo conversations; replies are not sent from Conversa yet)
  text: { type: String, default: null },
  messageType: { type: String, default: 'text' },
  receivedAt: { type: Date, default: Date.now },
  // An image the customer sent (e.g. a payment screenshot), kept on disk like payment proofs. paymentId = the record filed from it.
  attachment: { type: { file: String, contentType: String, size: Number, sha256: String }, default: null, _id: false },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  // Automatic payment detection for an image: processing -> filed | review | duplicate | not_payment | failed. claimedAt makes sure one worker handles it.
  paymentScan: { type: { state: String, reason: String, at: Date, claimedAt: { type: Date, default: null } }, default: null, _id: false },
  // How an outbound message left Conversa: 'real' = sent through the channel's API; 'simulated' = stored only (demo conversation, or the channel is not connected).
  delivery: { type: { mode: String, state: String, sentAt: Date, error: String }, default: null, _id: false }, // state: sent | delivered | read | failed
  readAt: { type: Date, default: null }, // null = unread
  isDemo: { type: Boolean, default: false },
}, { timestamps: true });
messageSchema.index({ channel: 1, externalId: 1 }, { unique: true });
messageSchema.index({ conversation: 1, receivedAt: 1 }); // a conversation's history, in order
messageSchema.index({ paymentId: 1 }, { sparse: true });

export default mongoose.models.Message || mongoose.model('Message', messageSchema);
