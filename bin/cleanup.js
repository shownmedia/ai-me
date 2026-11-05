#!/usr/bin/env node
// Dry run of Clean Up on one thread: prints which bot message becomes the summary, what would be deleted and the summary
// itself, without changing anything. --apply really does it (the bot normally does this on its own).
//
//   npm run cleanup -- <slack permalink> [--apply]
import { WebClient } from '@slack/web-api';
import { config } from '../src/config.js';
import { createStore } from '../src/store.js';
import { runCleanup } from '../src/cleanup.js';
import path from 'node:path';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const link = argv.find((a) => a.startsWith('http'));
const m = /archives\/(\w+)\/p(\d{10})(\d{6})/.exec(link || '');
if (!m) {
  console.error('usage: npm run cleanup -- <slack permalink> [--apply]');
  process.exit(2);
}
const channel = m[1];
const threadTs = new URL(link).searchParams.get('thread_ts') || `${m[2]}.${m[3]}`;
const client = new WebClient(config.botToken);
const { user_id: botUserId } = await client.auth.test();
// --apply works on the bot's real state, so only while the bot is stopped (same rule as editing state.json).
const store = apply ? createStore(path.join(config.dataDir, 'state.json')) : null;
const threads = store?.state.threads || {};
let t = threads[`${channel}:${threadTs}`];
if (!t && apply) {
  console.error("the bot doesn't track that thread, so --apply won't touch it");
  process.exit(1);
}
if (!t) {
  // Dry run on a thread the bot doesn't know: asks are what the bot would have taken (every DM message, tags in channels).
  const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200 });
  const asked = (x) => x.user === config.ownerId && (channel.startsWith('D') || (x.text || '').includes(`<@${botUserId}>`));
  t = { channel, threadTs, sessionId: `try-${threadTs}`, askTs: (res.messages || []).filter(asked).map((x) => x.ts) };
}
if (!t.askTs?.length) {
  console.log('nothing to clean: no tracked asks in this thread');
  process.exit(0);
}
const res = await runCleanup({ client, config, t, botUserId, save: store?.save, log: console.log, dryRun: !apply });
if (!res.plan) console.log('skipped: the thread was started by a bot post, or has no bot message to edit');
else {
  console.log(`delete ${res.plan.delete.length}: ${res.plan.delete.map((d) => `${d.ts}${d.owner ? ' (owner)' : ''}`).join(', ')}`);
  console.log(`edit ${res.plan.edit} into:\n\n${res.summary}`);
}
