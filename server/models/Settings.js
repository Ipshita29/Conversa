import mongoose from 'mongoose';

// Single-business app: one settings document. (No multi-tenant scoping is implemented.)
const ruleSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 80 },
  keywords: { type: [String], required: true },
  baseMinutes: { type: Number, required: true, min: 0 },
  perUnitMinutes: { type: Number, required: true, min: 0 },
}, { _id: false });

const settingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  timezone: String,
  workingDays: [Number],
  workStart: String,
  workEnd: String,
  dailyCapacityMinutes: Number,
  riskBufferMinutes: Number,
  customisationMinutes: Number,
  prepRules: [ruleSchema],
}, { timestamps: true });

export default mongoose.models.Settings || mongoose.model('Settings', settingsSchema);
