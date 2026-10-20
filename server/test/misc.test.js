import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { zonedTimeToUtc, zonedParts, isValidTimeZone } from '../utils/timezone.js';
import { verifyMetaSignature } from '../utils/signature.js';
import { validateOrderInput, validateEvidenceInput } from '../utils/validation.js';
import { validateSettingsPatch } from '../services/settingsService.js';
import { defaultSettings } from '../config/defaults.js';
import * as wa from '../services/integrations/whatsappService.js';
import * as ig from '../services/integrations/instagramService.js';

test('timezone conversion, including a DST transition', () => {
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 20, hour: 9 }, 'Asia/Kolkata').toISOString(), '2026-10-20T03:30:00.000Z');
  assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 12 }, 'America/New_York').toISOString(), '2026-03-07T17:00:00.000Z'); // EST
  assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 9, hour: 12 }, 'America/New_York').toISOString(), '2026-03-09T16:00:00.000Z'); // EDT
  assert.deepEqual(zonedParts(new Date('2026-10-19T20:00:00Z'), 'Asia/Kolkata').day, 20); // already tomorrow in IST
  assert.equal(isValidTimeZone('Mars/Base'), false);
});

test('order validation: required fields, enums, read-only and unknown fields, null handling', () => {
  assert.equal(validateOrderInput({ customerName: 'A', item: 'B' }).details.length, 0);
  const full = validateOrderInput({ customerName: ' A ', item: 'B', quantity: 2, prepTimeMinutes: null, deadline: null, source: 'instagram', status: 'confirmed', paymentStatus: 'pending' });
  assert.equal(full.details.length, 0);
  assert.equal(full.value.customerName, 'A');
  const fields = (b, o) => validateOrderInput(b, o).details.map((d) => d.field).sort();
  assert.deepEqual(fields({}), ['customerName', 'item']);
  assert.deepEqual(fields({ customerName: 'A', item: 'B', id: 'x', risk: 'high', evil: 1 }), ['evil', 'id', 'risk']);
  assert.deepEqual(fields({ customerName: 'A', item: 'B', quantity: 0, prepTimeMinutes: 1.5, deadline: '2026-10-20', status: 'done' }), ['deadline', 'prepTimeMinutes', 'quantity', 'status']);
  assert.deepEqual(fields({ quantity: '2' }, { partial: true }), ['quantity']);
  assert.deepEqual(fields({ customerName: { $ne: null }, item: 'B' }), ['customerName']);
  assert.deepEqual(fields('nope'), ['body']);
});

test('payment evidence validation (reference only, no verification claims)', () => {
  assert.equal(validateEvidenceInput({ reference: 'https://x/y.png', kind: 'screenshot_reference' }).details.length, 0);
  assert.equal(validateEvidenceInput({}).details[0].field, 'reference');
  assert.equal(validateEvidenceInput({ reference: 'r', kind: 'verified' }).details[0].field, 'kind');
});

test('settings validation', () => {
  const cur = defaultSettings();
  const bad = (b) => validateSettingsPatch(b, cur).details.map((d) => d.field).sort();
  assert.deepEqual(bad({ timezone: 'Nowhere/Land' }), ['timezone']);
  assert.deepEqual(bad({ workingDays: [1, 1, 9] }), ['workingDays']);
  assert.deepEqual(bad({ workStart: '18:00' }), ['workEnd']); // start would be after existing end 18:00
  assert.deepEqual(bad({ dailyCapacityMinutes: 0, extra: 1 }), ['dailyCapacityMinutes', 'extra']);
  assert.deepEqual(bad({ prepRules: [{ name: 'x' }] }), ['prepRules']);
  assert.equal(validateSettingsPatch({ timezone: 'Europe/London', workStart: '08:00', workEnd: '16:00' }, cur).details.length, 0);
});

test('Meta signature verification uses the raw body and constant-time comparison', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifyMetaSignature(body, sig, 's3cret'), true);
  assert.equal(verifyMetaSignature(Buffer.from('{"a":2}'), sig, 's3cret'), false);
  assert.equal(verifyMetaSignature(body, sig, 'other'), false);
  assert.equal(verifyMetaSignature(body, 'sha256=zz', 's3cret'), false);
  assert.equal(verifyMetaSignature(body, undefined, 's3cret'), false);
  assert.equal(verifyMetaSignature(body, sig, ''), false);
});

test('WhatsApp webhook parsing (text, non-text, contact names, wrong object)', () => {
  const payload = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
    contacts: [{ profile: { name: 'Priya' }, wa_id: '9198' }],
    messages: [{ from: '9198', id: 'wamid.1', timestamp: '1760000000', type: 'text', text: { body: 'Hi' } }, { from: '9198', id: 'wamid.2', timestamp: '1760000001', type: 'image' }] } }] }] };
  const out = wa.parseWebhook(payload);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].contactName, out[0].text, out[1].text, out[1].messageType], ['Priya', 'Hi', null, 'image']);
  assert.deepEqual(wa.parseWebhook({ object: 'page', entry: [] }), []);
  assert.deepEqual(wa.parseWebhook(null), []);
});

test('Instagram webhook parsing ignores echoes of our own messages', () => {
  const payload = { object: 'instagram', entry: [{ id: 'biz', time: 1, messaging: [
    { sender: { id: 'u1' }, recipient: { id: 'biz' }, timestamp: 1760000000000, message: { mid: 'm1', text: 'Hello' } },
    { sender: { id: 'biz' }, recipient: { id: 'u1' }, timestamp: 1760000000001, message: { mid: 'm2', text: 'reply', is_echo: true } }] }] };
  const out = ig.parseWebhook(payload);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].contactId, out[0].text], ['u1', 'Hello']);
});

test('webhook verification handshake', () => {
  const cfg = { meta: { whatsapp: { verifyToken: 'vt' }, instagram: { verifyToken: '' } } };
  assert.deepEqual(wa.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '123' }, cfg), { ok: true, challenge: '123' });
  assert.equal(wa.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '1' }, cfg).status, 403);
  assert.equal(ig.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, cfg).status, 503);
});

test('integration status never claims "connected" without a successful credential check', async () => {
  const none = { meta: { appSecret: '', whatsapp: { accessToken: '', phoneNumberId: '', verifyToken: '' }, instagram: { accessToken: '', verifyToken: '' } } };
  const s1 = await wa.checkStatus({}, none);
  assert.equal(s1.status, 'unavailable');
  assert.match(s1.statusReason, /WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID/);

  const cfg = { meta: { appSecret: 'x', whatsapp: { accessToken: 'tok', phoneNumberId: '123', verifyToken: 'v' }, instagram: { accessToken: 'tok', verifyToken: 'v' } } };
  const reject = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const s2 = await wa.checkStatus({ fetchImpl: reject }, cfg);
  assert.equal(s2.status, 'unavailable');
  assert.ok(!JSON.stringify(s2).includes('tok'));
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await ig.checkStatus({ fetchImpl: down }, cfg)).status, 'unavailable');

  const okWa = async () => ({ ok: true, status: 200, json: async () => ({ verified_name: 'Sweet Bakes' }) });
  const s3 = await wa.checkStatus({ fetchImpl: okWa }, cfg);
  assert.equal(s3.status, 'connected');
  assert.equal(s3.accountLabel, 'Sweet Bakes');
  assert.equal(s3.webhookConfigured, true);
});
