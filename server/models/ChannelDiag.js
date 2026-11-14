import mongoose from 'mongoose';

// What the webhook last did for a channel, for the Settings diagnostics: when Meta last completed the verification handshake, when a webhook last arrived,
// and the last time one failed (and why). No secrets and no message content.
const schema = new mongoose.Schema({
  channel: { type: String, enum: ['whatsapp', 'instagram'], required: true, unique: true },
  verifiedAt: { type: Date, default: null },
  lastReceivedAt: { type: Date, default: null },
  lastError: { type: { at: Date, code: String, message: String }, default: null, _id: false },
}, { timestamps: false });

export const noteWebhook = (channel, patch) => mongoose.models.ChannelDiag.updateOne({ channel }, { $set: patch }, { upsert: true }).catch(() => {});
export default mongoose.models.ChannelDiag || mongoose.model('ChannelDiag', schema);
