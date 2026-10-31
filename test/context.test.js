import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageText, renderMessage, freshMessages, renderContext } from '../src/context.js';
import { buildPrompt, gatherContext } from '../src/prompt.js';

const opts = { botUserId: 'UBOT', ownerId: 'UOWN', ownerName: 'Mitchell', names: { UMAE: 'Mae', UOWN: 'Mitchell' } };

test('bot posts fall back to attachments and blocks when text is empty', () => {
  assert.equal(messageText({ text: '', blocks: [{ type: 'section', text: { text: 'launch moved' } }] }), 'launch moved');
  assert.equal(messageText({ text: 'hi', attachments: [{ fallback: 'card' }] }), 'hi\ncard');
});

test('messages are labelled by who sent them, with mentions named and files listed', () => {
  assert.match(renderMessage({ ts: '1792160616.5', user: 'UOWN', text: '<@UBOT> center it' }, opts), /Mitchell \(owner\): <@UBOT> center it/);
  assert.match(renderMessage({ ts: '1', user: 'UMAE', text: 'cc <@UOWN>', files: [{ name: 'a.png' }] }, opts), /Mae \(<@UMAE>\): cc @Mitchell \(<@UOWN>\)\n\[file: a\.png\]/);
  assert.match(renderMessage({ ts: '1', user: 'UBOT', bot_id: 'B1', text: 'shipped' }, opts), /you \(your earlier reply\): shipped/);
  assert.match(renderMessage({ ts: '1', bot_id: 'B2', bot_profile: { name: 'Lumen' }, text: 'x' }, opts), /Lumen \(bot\): x/);
  const echo = renderMessage({ ts: '1', user: 'UOWN', text: 'sent it\n\n*Sent using* <@U0CLAUDE|Claude>' }, opts);
  assert.match(echo, /Slack connector/);
  assert.doesNotMatch(echo, /Sent using/);
  assert.match(renderMessage({ ts: '1', user: 'UGONE', text: 'hey' }, opts), /<@UGONE>: hey/);
});

test('fresh messages: after the cursor, minus the asks and the bot status lines', () => {
  const msgs = [
    { ts: '3', user: 'UMAE', text: 'later' },
    { ts: '1', user: 'UOWN', text: 'old' },
    { ts: '2', user: 'UBOT', text: 'done :white_check_mark: · 18m' },
    { ts: '2.5', user: 'UBOT', text: "yes, i'm on it. should take about 8 min." },
    { ts: '4', user: 'UOWN', text: 'the ask' },
    { ts: '5', user: 'UBOT', text: 'real reply' },
  ];
  assert.deepEqual(freshMessages(msgs, { skipTs: ['4'], botUserId: 'UBOT' }).map((m) => m.ts), ['1', '3', '5']);
  assert.deepEqual(freshMessages(msgs, { after: '1', skipTs: ['4'], botUserId: 'UBOT', skipOwn: true }).map((m) => m.ts), ['3']);
});

test('long threads keep the first message and the newest, and say what was cut', () => {
  const msgs = Array.from({ length: 200 }, (_, i) => ({ ts: String(i + 1), user: 'UMAE', text: `message ${i} ${'x'.repeat(200)}` }));
  const out = renderContext(msgs, opts, 5_000);
  assert.ok(out.length < 5_500);
  assert.match(out, /message 0 /);
  assert.match(out, /message 199 /);
  assert.match(out, /older messages left out/);
});

const fakeClient = (thread, history = []) => ({
  conversations: {
    replies: async () => ({ messages: thread }),
    history: async () => ({ messages: history }),
  },
  users: { info: async ({ user }) => ({ user: { profile: { display_name: { UMAE: 'Mae' }[user] || '' } } }) },
});
const who = { botUserId: 'UBOT', ownerId: 'UOWN', ownerName: 'Mitchell' };

test('first run in a thread gets the whole thread; the next run only what is new', async () => {
  const thread = [
    { ts: '10', bot_id: 'B2', bot_profile: { name: 'Lumen' }, text: 'Rayline launch date moved' },
    { ts: '11', user: 'UOWN', text: '<@UBOT> add emoji' },
  ];
  const t = { channel: 'C1', threadTs: '10' };
  const first = await gatherContext(fakeClient(thread), t, [{ ts: '11' }], who);
  assert.match(first.text, /The Slack thread so far[\s\S]*Rayline launch date moved/);
  assert.doesNotMatch(first.text, /add emoji/); // the ask is shown separately
  assert.equal(first.newest, '11');
  t.contextTs = first.newest;
  t.started = true;
  const next = [...thread, { ts: '12', user: 'UBOT', text: 'shipped' }, { ts: '13', user: 'UMAE', text: 'it errors for me' }, { ts: '14', user: 'UOWN', text: '<@UBOT> fix that' }];
  const second = await gatherContext(fakeClient(next), t, [{ ts: '14' }], who);
  assert.match(second.text, /New in this Slack thread since your last turn[\s\S]*Mae \(<@UMAE>\): it errors for me/);
  assert.doesNotMatch(second.text, /Rayline|shipped/);
});

test('a top-level ask gets the conversation just before it', async () => {
  const t = { channel: 'D1', threadTs: '20' };
  const ctx = await gatherContext(fakeClient([{ ts: '20', user: 'UOWN', text: 'do the thing above' }], [{ ts: '19', user: 'UOWN', text: 'the thing: rename the sheet' }]), t, [{ ts: '20' }], who);
  assert.match(ctx.text, /just before the ask[\s\S]*rename the sheet/);
});

test('a Slack failure means less context, never a failed run', async () => {
  const broken = { conversations: { replies: async () => { throw new Error('ratelimited'); } } };
  const ctx = await gatherContext(broken, { channel: 'C1', threadTs: '1', contextTs: '5' }, [{ ts: '6' }], who);
  assert.deepEqual(ctx, { text: '', newest: '5' });
});

test('the prompt puts the context before the ask and says where the reply goes', () => {
  const cfg = { ownerId: 'UOWN', ownerName: 'Mitchell' };
  const p = buildPrompt(cfg, { channel: 'C1', permalink: 'https://x' }, [{ text: 'center it' }], 'THREAD');
  assert.ok(p.indexOf('THREAD') < p.indexOf('center it'));
  assert.match(p, /Mitchell's ask/);
  assert.match(p, /channel reply format/);
});
