// Demo clean-up and re-seeding against a throwaway local mongod (skipped, loudly, if `mongod` is not installed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDb } from '../config/db.js';
import Order from '../models/Order.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { refreshStaleDemo, reseedDemoOrders, reseedDemoMessages, removeDemoMessages } from '../services/demoSeed.js';
import { buildBoard } from '../services/boardService.js';
import { getSettings } from '../services/settingsService.js';

const hasMongod = spawnSync('mongod', ['--version']).status === 0;
const skip = hasMongod ? false : 'mongod not installed: integration tests skipped';
let proc; let dir;
before(async () => {
  if (!hasMongod) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversa-demo-'));
  const port = 28000 + Math.floor(Math.random() * 1000);
  proc = spawn('mongod', ['--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { if (await connectDb(`mongodb://127.0.0.1:${port}/conversa_demo_test`)) break; await new Promise((r) => setTimeout(r, 500)); }
});
after(async () => { await mongoose.disconnect(); proc?.kill(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const demoNames = async () => (await Order.find({ notes: /^\[DEMO\]/ }).lean()).map((o) => o.customerName).sort();
const FIVE = ['Aanya Sharma', 'Kabir Singh', 'Meera Iyer', 'Neha Sharma', 'Rohan Mehta'];

test('cleaning up a polluted demo leaves exactly the five orders and their five chats, and never touches real data', { skip }, async () => {
  // Real data that must survive: orders (one with the same name as a demo customer), a conversation and a message.
  const real = await Order.create([
    { customerName: 'Neha Sharma', item: 'Chocolate birthday cake (2 kg)', quantity: 1, status: 'in_progress', prepTimeMinutes: 240, deadline: new Date(Date.now() + 2 * 86400000) },
    { customerName: 'Nikhil Rao', item: 'cake pops', quantity: 30, status: 'completed' },
  ]);
  const realConv = await Conversation.create({ channel: 'whatsapp', contactId: '919800000001', customerName: 'Real Customer', isDemo: false, orderId: real[1]._id });
  await Message.create({ conversation: realConv._id, channel: 'whatsapp', externalId: 'real-1', text: 'a real message', isDemo: false });

  // Pollute the demo on purpose: extra demo orders (an old customer, a duplicate Neha), an old chat and an orphaned demo message.
  const { created } = await reseedDemoOrders(new Date());
  await Order.create([
    { customerName: 'Tara Bose', item: 'Brownie tray', status: 'completed', notes: '[DEMO] old' },
    { customerName: 'Neha Sharma', item: 'Duplicate cake', status: 'pending', notes: '[DEMO] duplicate', prepTimeMinutes: 60, deadline: new Date(Date.now() + 86400000) },
  ]);
  await reseedDemoMessages(created);
  const old = await Conversation.create({ channel: 'whatsapp', contactId: 'demo-whatsapp-nikhil-rao', customerName: 'Nikhil Rao', isDemo: true });
  await Message.create({ conversation: old._id, channel: 'whatsapp', externalId: 'demo-old', text: 'Any chance of 30 cake pops?', isDemo: true });
  await Message.create({ conversation: new mongoose.Types.ObjectId(), channel: 'whatsapp', externalId: 'demo-orphan', text: 'orphan', isDemo: true });
  assert.equal((await demoNames()).length, 7);

  assert.equal(await refreshStaleDemo(), true); // the clean-up
  assert.deepEqual(await demoNames(), FIVE);
  const chats = await Conversation.find({ isDemo: true }).lean();
  assert.deepEqual(chats.map((c) => c.customerName).sort(), FIVE);
  assert.ok(chats.every((c) => c.orderId), 'every demo chat points at its demo order');
  assert.equal(await Message.countDocuments({ isDemo: true }), 5);
  assert.equal(await Message.countDocuments({ isDemo: true, readAt: null }), 1); // one unread message

  // Real data is exactly as it was.
  assert.equal(await Order.countDocuments({ notes: { $not: /^\[DEMO\]/ } }), 2);
  assert.ok(await Order.exists({ customerName: 'Nikhil Rao', item: 'cake pops' }));
  assert.ok(await Order.exists({ customerName: 'Neha Sharma', item: 'Chocolate birthday cake (2 kg)', notes: null }));
  assert.ok(await Conversation.exists({ _id: realConv._id })); assert.ok(await Message.exists({ externalId: 'real-1' }));
});

test('re-seeding and restarting are idempotent: nothing is duplicated and nothing comes back', { skip }, async () => {
  const before = (await Order.find({ notes: /^\[DEMO\]/ }).lean()).map((o) => String(o._id)).sort();
  assert.equal(await refreshStaleDemo(), false); // a restart changes nothing
  assert.equal(await refreshStaleDemo(), false);
  assert.deepEqual((await Order.find({ notes: /^\[DEMO\]/ }).lean()).map((o) => String(o._id)).sort(), before);
  await reseedDemoOrders(new Date()); await reseedDemoOrders(new Date()); // the seed script, run twice
  assert.deepEqual(await demoNames(), FIVE);
  await reseedDemoMessages(await Order.find({ notes: /^\[DEMO\]/ }));
  assert.equal(await Conversation.countDocuments({ isDemo: true }), 5);
});

test('the Demo view of the board holds exactly the five orders (1 overdue, 2 on track, 2 upcoming), whatever real orders exist', { skip }, async () => {
  const orders = (await Order.find().lean()).map((o) => ({ ...o, id: String(o._id) }));
  const b = buildBoard({ orders, settings: await getSettings(), now: new Date(), dataset: 'demo' });
  assert.equal(b.total, 5); assert.equal(b.needsDetails.length, 0);
  assert.deepEqual(Object.values(b.sections).flat().map((x) => x.customerName).sort(), FIVE);
  assert.deepEqual(b.counts, { overdue: 1, onTrack: 2, upcoming: 2 });
});

test('clearing the demo removes only demo records', { skip }, async () => {
  await Order.deleteMany({ notes: /^\[DEMO\]/ }); const gone = await removeDemoMessages();
  assert.equal(gone.conversations, 5);
  assert.equal(await Order.countDocuments(), 2); assert.equal(await Conversation.countDocuments(), 1); assert.equal(await Message.countDocuments(), 1);
  assert.equal(await refreshStaleDemo(), false); // with no demo, a restart does not bring it back
});
