import Settings from '../models/Settings.js';
import { defaultSettings } from '../config/defaults.js';
import { isValidTimeZone } from '../utils/timezone.js';
import { isPlainObject } from '../utils/validation.js';
import { validationError } from '../utils/errors.js';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const FIELDS = ['timezone', 'workingDays', 'workStart', 'workEnd', 'dailyCapacityMinutes', 'riskBufferMinutes', 'customisationMinutes', 'prepRules'];
const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

export const pickSettings = (doc) => {
  const d = defaultSettings();
  const o = doc ? (doc.toObject ? doc.toObject() : doc) : {};
  return Object.fromEntries(FIELDS.map((k) => [k, o[k] ?? d[k]]));
};

export async function getSettings() {
  return pickSettings(await Settings.findOne({ key: 'default' }).lean());
}

export function validateSettingsPatch(body, current) {
  const details = [];
  const add = (field, message) => details.push({ field, message });
  if (!isPlainObject(body)) return { value: {}, details: [{ field: 'body', message: 'Request body must be a JSON object.' }] };
  for (const k of Object.keys(body)) if (!FIELDS.includes(k)) add(k, 'Unknown field.');
  const value = {};

  if ('timezone' in body) { if (!isValidTimeZone(body.timezone)) add('timezone', 'Must be a valid IANA timezone, e.g. Asia/Kolkata.'); else value.timezone = body.timezone; }
  if ('workingDays' in body) {
    const d = body.workingDays;
    if (!Array.isArray(d) || d.length === 0 || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6) || new Set(d).size !== d.length) add('workingDays', 'Must be a non-empty list of unique weekday numbers 0 (Sunday) to 6 (Saturday).');
    else value.workingDays = [...d].sort();
  }
  for (const f of ['workStart', 'workEnd']) if (f in body) { if (typeof body[f] !== 'string' || !HM.test(body[f])) add(f, 'Must be HH:mm (24-hour).'); else value[f] = body[f]; }
  for (const [f, min, max] of [['dailyCapacityMinutes', 1, 1440], ['riskBufferMinutes', 0, 1440], ['customisationMinutes', 0, 1440]]) {
    if (f in body) { if (!Number.isInteger(body[f]) || body[f] < min || body[f] > max) add(f, `Must be a whole number from ${min} to ${max}.`); else value[f] = body[f]; }
  }
  if ('prepRules' in body) {
    const r = body.prepRules;
    if (!Array.isArray(r) || r.length > 50) add('prepRules', 'Must be a list of at most 50 rules.');
    else {
      const ok = r.every((x) => isPlainObject(x) && typeof x.name === 'string' && x.name.trim() && x.name.length <= 80 && Array.isArray(x.keywords) && x.keywords.length > 0 && x.keywords.every((k) => typeof k === 'string' && k.trim())
        && Number.isFinite(x.baseMinutes) && x.baseMinutes >= 0 && Number.isFinite(x.perUnitMinutes) && x.perUnitMinutes >= 0);
      if (!ok) add('prepRules', 'Each rule needs name, keywords[], baseMinutes >= 0 and perUnitMinutes >= 0.');
      else value.prepRules = r.map((x) => ({ name: x.name.trim(), keywords: x.keywords.map((k) => k.trim()), baseMinutes: x.baseMinutes, perUnitMinutes: x.perUnitMinutes }));
    }
  }
  const merged = { ...current, ...value };
  if (!details.some((d) => ['workStart', 'workEnd'].includes(d.field)) && toMin(merged.workEnd) <= toMin(merged.workStart)) add('workEnd', 'Must be later than workStart.');
  return { value, details };
}

export async function updateSettings(body) {
  const current = await getSettings();
  const { value, details } = validateSettingsPatch(body, current);
  if (details.length) throw validationError(details);
  const doc = await Settings.findOneAndUpdate({ key: 'default' }, { $set: value }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return pickSettings(doc);
}
