import { config } from './env.js';

// Default preparation-time rules: minutes = baseMinutes + perUnitMinutes * quantity.
// These are configurable starting points chosen by the developers, NOT learned from historical data.
export const DEFAULT_PREP_RULES = [
  { name: 'Cupcakes', keywords: ['cupcake'], baseMinutes: 30, perUnitMinutes: 6 },
  { name: 'Cake', keywords: ['cake'], baseMinutes: 60, perUnitMinutes: 120 },
  { name: 'Cookies', keywords: ['cookie'], baseMinutes: 20, perUnitMinutes: 4 },
  { name: 'Brownies', keywords: ['brownie'], baseMinutes: 30, perUnitMinutes: 4 },
  { name: 'Macarons', keywords: ['macaron'], baseMinutes: 45, perUnitMinutes: 5 },
  { name: 'Gift hamper', keywords: ['hamper'], baseMinutes: 30, perUnitMinutes: 45 },
  { name: 'Wedding favours', keywords: ['favour', 'favor'], baseMinutes: 30, perUnitMinutes: 8 },
  { name: 'Portrait / painting', keywords: ['portrait', 'painting', 'sketch', 'drawing'], baseMinutes: 30, perUnitMinutes: 240 },
];

export const defaultSettings = () => ({
  timezone: config.businessTimezone,
  workingDays: [1, 2, 3, 4, 5, 6], // 0 = Sunday
  workStart: '09:00',
  workEnd: '18:00',
  dailyCapacityMinutes: 360, // productive preparation minutes per working day (less than the open window: breaks, admin)
  riskBufferMinutes: 240, // finishing with less slack than this before a deadline is "medium" risk
  customisationMinutes: 30, // added when an order has customisation notes
  prepRules: DEFAULT_PREP_RULES,
});
