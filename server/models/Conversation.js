import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema({
  channel: { type: String, enum: ['whatsapp', 'instagram'], required: true },
  contactId: { type: String, required: true }, // WhatsApp wa_id / Instagram-scoped user id
  customerName: { type: String, default: null },
  lastMessageAt: { type: Date, default: Date.now },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null }, // order created from / related to this conversation
  isDemo: { type: Boolean, default: false },
}, { timestamps: true });
conversationSchema.index({ channel: 1, contactId: 1 }, { unique: true });

export default mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);
