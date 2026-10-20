// HTTP integration tests. Start a throwaway local mongod (skipped, loudly, if `mongod` is not installed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { createApp } from '../app.js';
import { connectDb } from '../config/db.js';
import { config } from '../config/env.js';

const hasMongod = spawnSync('mongod', ['--version']).status === 0;
const skip = hasMongod ? false : 'mongod not installed: integration tests skipped';
let proc; let server; let base; let dir;

before(async () => {
  if (!hasMongod) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-test-'));
  const port = 27000 + Math.floor(Math.random() * 1000);
  proc = spawn('mongod', ['--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { // wait for startup
    if (await connectDb(`mongodb://127.0.0.1:${port}/conversa_test`)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  Object.assign(config.meta, { appSecret: 'testsecret' });
  Object.assign(config.meta.whatsapp, { verifyToken: 'wa-verify' });
  config.groq.apiKey = '';
});
after(async () => {
  server?.close();
  await mongoose.disconnect();
  proc?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
};
const future = (h) => new Date(Date.now() + h * 3600000).toISOString();

test('health, unknown routes and malformed JSON use the shared error format', { skip }, async () => {
  const h = await call('GET', '/health');
  assert.deepEqual(h.json, { status: 'ok', database: 'connected' });
  const nf = await call('GET', '/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, 'NOT_FOUND');
  const bad = await call('POST', '/orders', '{not json');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'VALIDATION_ERROR');
});

test('order CRUD with validation, defaults, ids and conflicts', { skip }, async () => {
  const inv = await call('POST', '/orders', { item: 'x', evil: 1, quantity: 0 });
  assert.equal(inv.status, 422);
  assert.equal(inv.json.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(inv.json.error.details.map((d) => d.field).sort(), ['customerName', 'evil', 'quantity']);

  const c = await call('POST', '/orders', { customerName: 'Priya', item: 'Cupcakes', quantity: 12 });
  assert.equal(c.status, 201);
  assert.match(c.headers.get('location'), /^\/api\/orders\/[a-f0-9]{24}$/);
  assert.deepEqual([c.json.status, c.json.paymentStatus, c.json.source, c.json.prepTimeMinutes, c.json.deadline, c.json.risk], ['pending', 'unverified', 'manual', null, null, null]);
  assert.ok(c.json.id && c.json.createdAt && c.json.updatedAt && !c.json._id && !c.json.__v);

  const g = await call('GET', `/orders/${c.json.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.json.customerName, 'Priya');
  assert.equal((await call('GET', '/orders/not-an-id')).status, 404);
  assert.equal((await call('GET', '/orders/aaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);

  const p = await call('PATCH', `/orders/${c.json.id}`, { prepTimeMinutes: 120, deadline: future(48), status: 'confirmed' });
  assert.equal(p.status, 200);
  assert.equal(p.json.prepTimeMinutes, 120);
  assert.ok(['low', 'medium', 'high'].includes(p.json.risk));
  assert.equal((await call('PATCH', `/orders/${c.json.id}`, {})).status, 422);
  assert.equal((await call('PATCH', `/orders/${c.json.id}`, { id: 'x', risk: 'low' })).status, 422);
  assert.equal((await call('PATCH', `/orders/${c.json.id}`, { deadline: 'tomorrow' })).status, 422);

  await call('PATCH', `/orders/${c.json.id}`, { status: 'completed' });
  const conflict = await call('PATCH', `/orders/${c.json.id}`, { status: 'in_progress' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'CONFLICT');
});

test('list: filters, pagination, sorting (nulls last) and injection-safe queries', { skip }, async () => {
  await call('POST', '/orders', { customerName: 'A', item: 'Cake', source: 'whatsapp', deadline: future(30), prepTimeMinutes: 60 });
  await call('POST', '/orders', { customerName: 'B', item: 'Cake', source: 'instagram', deadline: future(10), prepTimeMinutes: 60 });
  await call('POST', '/orders', { customerName: 'C', item: 'Cake', source: 'instagram' });
  const all = await call('GET', '/orders?pageSize=100');
  assert.equal(all.status, 200);
  assert.ok(all.json.total >= 4);
  const withDeadline = all.json.items.filter((o) => o.deadline);
  assert.ok(withDeadline.every((o, i, a) => i === 0 || new Date(a[i - 1].deadline) <= new Date(o.deadline)));
  assert.equal(all.json.items.at(-1).deadline, null); // nulls last
  const ig = await call('GET', '/orders?source=instagram&status=pending');
  assert.ok(ig.json.items.length >= 2 && ig.json.items.every((o) => o.source === 'instagram'));
  const page = await call('GET', '/orders?pageSize=1&page=2');
  assert.equal(page.json.items.length, 1);
  assert.equal(page.json.page, 2);
  assert.equal((await call('GET', '/orders?status=bogus')).status, 400);
  assert.equal((await call('GET', '/orders?pageSize=1000')).status, 400);
  assert.equal((await call('GET', '/orders?status[$ne]=pending')).status, 400); // Mongo operators from the client are rejected
  assert.equal((await call('GET', '/orders?sort=password')).status, 400);
});

test('planner and dashboard agree; completed/cancelled orders are excluded', { skip }, async () => {
  const mk = (o) => call('POST', '/orders', { customerName: 'W', item: 'Thing', ...o });
  await mk({ prepTimeMinutes: 100, deadline: future(72), status: 'completed' });
  await mk({ prepTimeMinutes: 100, deadline: future(72), status: 'cancelled' });
  const [pl, db] = await Promise.all([call('GET', '/planner?days=7'), call('GET', '/dashboard')]);
  assert.equal(pl.status, 200);
  assert.equal(db.status, 200);
  assert.equal(pl.json.workload.pendingMinutes, db.json.workload.pendingMinutes);
  assert.equal(pl.json.workload.availableMinutes, db.json.workload.availableMinutes);
  const orders = (await call('GET', '/orders?pageSize=100')).json.items;
  const expected = orders.filter((o) => ['pending', 'confirmed', 'in_progress'].includes(o.status)).reduce((s, o) => s + (o.prepTimeMinutes ?? 0), 0);
  assert.equal(pl.json.workload.pendingMinutes, expected);
  assert.deepEqual(Object.keys(db.json.stats).sort(), ['atRisk', 'completed', 'inProgress', 'pending', 'total']);
  assert.ok(pl.json.days.length === 7 && pl.json.range.timezone);
  assert.equal((await call('GET', '/planner?days=99')).status, 400);
  assert.equal((await call('GET', '/planner?from=soon')).status, 400);
});

test('simulation never changes saved orders', { skip }, async () => {
  const before = JSON.stringify((await call('GET', '/orders?pageSize=100')).json);
  const sim = await call('POST', '/planner/simulate', { changes: [{ type: 'add_order', order: { customerName: 'Sim', item: 'Huge', prepTimeMinutes: 2000, deadline: future(24) } }], days: 7 });
  assert.equal(sim.status, 200);
  assert.equal(sim.json.simulated, true);
  assert.ok(sim.json.comparison.newRisks.length >= 1);
  assert.equal(JSON.stringify((await call('GET', '/orders?pageSize=100')).json), before);
  assert.equal((await call('POST', '/planner/simulate', { changes: [] })).status, 422);
  assert.equal((await call('POST', '/planner/simulate', { changes: [{ type: 'cancel_order', orderId: 'ghost' }] })).status, 404);
  assert.equal((await call('POST', '/planner/simulate', [])).status, 422);
});

test('payment evidence is attached without changing payment status', { skip }, async () => {
  const o = (await call('POST', '/orders', { customerName: 'Pay', item: 'Cake' })).json;
  const r = await call('POST', `/orders/${o.id}/payment-evidence`, { kind: 'screenshot_reference', reference: 'https://example.com/shot.png', amount: 500 });
  assert.equal(r.status, 201);
  assert.equal(r.json.paymentEvidence.length, 1);
  assert.equal(r.json.paymentStatus, 'unverified');
  assert.equal((await call('POST', `/orders/${o.id}/payment-evidence`, {})).status, 422);
});

test('settings: defaults, validated updates, and effect on capacity', { skip }, async () => {
  const s = await call('GET', '/settings');
  assert.equal(s.status, 200);
  assert.ok(s.json.timezone && s.json.workingDays.length && s.json.prepRules.length);
  assert.equal((await call('PATCH', '/settings', { timezone: 'Nope/Nope' })).status, 422);
  assert.equal((await call('PATCH', '/settings', { workEnd: '08:00' })).status, 422);
  const u = await call('PATCH', '/settings', { workingDays: [1, 2, 3, 4, 5, 6, 0], dailyCapacityMinutes: 300 });
  assert.equal(u.status, 200);
  assert.equal(u.json.dailyCapacityMinutes, 300);
  const pl = await call('GET', '/planner?days=7');
  assert.ok(pl.json.days.every((d) => d.capacityMinutes <= 300));
  assert.ok(pl.json.days.filter((d) => d.capacityMinutes > 0).length >= 6);
});

test('AI extraction validates input, reports unavailability, and never saves an order', { skip }, async () => {
  const count = async () => (await call('GET', '/orders?pageSize=1')).json.total;
  const before = await count();
  assert.equal((await call('POST', '/ai/extract-order', { source: 'whatsapp' })).status, 422);
  const r = await call('POST', '/ai/extract-order', { message: 'Cake for friday please', source: 'whatsapp' });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'AI_UNAVAILABLE');
  assert.ok(!JSON.stringify(r.json).toLowerCase().includes('bearer'));
  assert.equal(await count(), before);
});

test('integrations are honestly unavailable without credentials', { skip }, async () => {
  const r = await call('GET', '/integrations');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((i) => i.channel).sort(), ['instagram', 'whatsapp']);
  assert.ok(r.json.items.every((i) => i.status === 'unavailable' && /Missing environment variables/.test(i.statusReason)));
  const c = await call('POST', '/integrations/whatsapp/connect', {});
  assert.equal(c.status, 503);
  assert.equal(c.json.error.code, 'INTEGRATION_UNAVAILABLE');
  assert.equal((await call('POST', '/integrations/tiktok/connect', {})).status, 404);
});

test('webhooks: handshake, signature enforcement, storage, and duplicate suppression', { skip }, async () => {
  const hs = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=555`);
  assert.equal(hs.status, 200);
  assert.equal(await hs.text(), '555');
  assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);

  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { contacts: [{ profile: { name: 'Riya' }, wa_id: '9100' }], messages: [{ from: '9100', id: 'wamid.T1', timestamp: '1760000000', type: 'text', text: { body: 'Need a cake' } }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'testsecret').update(payload).digest('hex');
  assert.equal((await call('POST', '/webhooks/whatsapp', payload)).status, 401); // unsigned
  assert.equal((await call('POST', '/webhooks/whatsapp', payload, { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) })).status, 401);
  const ok = await call('POST', '/webhooks/whatsapp', payload, { 'X-Hub-Signature-256': sig });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.stored, 1);
  const retry = await call('POST', '/webhooks/whatsapp', payload, { 'X-Hub-Signature-256': sig });
  assert.equal(retry.json.stored, 0);
  assert.equal(retry.json.duplicates, 1);

  const conv = await call('GET', '/conversations');
  const riya = conv.json.items.find((c) => c.customerName === 'Riya');
  assert.ok(riya && riya.channel === 'whatsapp' && riya.messages.length === 1 && riya.messages[0].text === 'Need a cake');
  const orders = await call('GET', '/orders?pageSize=1');
  assert.ok(orders.json.total > 0); // webhook ingestion itself created no order
  assert.ok(!(await call('GET', '/orders?pageSize=100')).json.items.some((o) => o.customerName === 'Riya'));
});

test('without META_APP_SECRET webhooks refuse to process (never trust unsigned input)', { skip }, async () => {
  const saved = config.meta.appSecret;
  config.meta.appSecret = '';
  assert.equal((await call('POST', '/webhooks/instagram', { object: 'instagram', entry: [] })).status, 503);
  config.meta.appSecret = saved;
});
