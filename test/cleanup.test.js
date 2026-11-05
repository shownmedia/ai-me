import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLEANUP_COMMAND, cleanupDue, planCleanup, fallbackSummary, runCleanup } from '../src/cleanup.js';

const BOT = 'UBOT';
const OWNER = 'UOWNER';
const idle = (extra = {}) => ({ askTs: ['1.0'], pending: [], inflight: null, finalPending: null, lastOk: true, lastActivity: 0, ...extra });

test('the command is only "clean up" on its own', () => {
  for (const s of ['clean up', 'cleanup', 'Clean up!', 'clean up.']) assert.ok(CLEANUP_COMMAND.test(s), s);
  for (const s of ['clean up this doc', 'please clean up', 'cleanup the repo']) assert.ok(!CLEANUP_COMMAND.test(s), s);
});

test('due only when idle long enough, last run OK, owner-only and not busy', () => {
  const now = 61 * 60_000;
  assert.ok(cleanupDue(idle(), { now, afterMin: 60 }));
  assert.ok(!cleanupDue(idle(), { now: 59 * 60_000, afterMin: 60 }));
  assert.ok(!cleanupDue(idle(), { now, afterMin: null }), 'auto off');
  assert.ok(!cleanupDue(idle({ lastOk: false }), { now, afterMin: 60 }), 'failed runs stay for a look');
  assert.ok(!cleanupDue(idle({ lastOk: undefined }), { now, afterMin: 60 }));
  assert.ok(!cleanupDue(idle({ guest: {} }), { now, afterMin: 60 }));
  assert.ok(!cleanupDue(idle({ askTs: [] }), { now, afterMin: 60 }), 'threads from before this feature are never touched');
  assert.ok(!cleanupDue(idle({ askTs: undefined }), { now, afterMin: 60 }));
  assert.ok(!cleanupDue(idle({ pending: [{}] }), { now, afterMin: 60 }));
  assert.ok(!cleanupDue(idle({ finalPending: {} }), { now, afterMin: 60 }));
  assert.ok(!cleanupDue(idle(), { now, afterMin: 60, running: true }));
  assert.ok(cleanupDue(idle({ cleanupNow: true, lastOk: false, lastActivity: now }), { now, afterMin: null }), '"clean up" does it now');
  assert.ok(cleanupDue(idle({ cleanup: { done: [] }, lastActivity: now }), { now, afterMin: 60 }), 'a cut-off cleanup resumes');
});

const dmThread = [
  { ts: '1.0', user: OWNER, text: 'make the thing' },
  { ts: '1.1', user: BOT, text: "yes, i'm on it." },
  { ts: '1.2', user: BOT, text: `<@${OWNER}> done: https://x.com/a` },
  { ts: '1.3', user: OWNER, text: 'make it blue' },
  { ts: '1.4', user: BOT, text: `<@${OWNER}> blue now: https://x.com/b` },
];

test('the bot\'s first message becomes the summary; everything else goes, replies before the root', () => {
  const plan = planCleanup(dmThread, { askTs: ['1.0', '1.3'], botUserId: BOT, threadTs: '1.0' });
  assert.equal(plan.edit, '1.1');
  assert.deepEqual(plan.delete.map((d) => d.ts), ['1.2', '1.3', '1.4', '1.0']);
  assert.deepEqual(plan.delete.filter((d) => d.owner).map((d) => d.ts), ['1.3', '1.0']);
  assert.equal(plan.transcript.length, 5);
});

test('file uploads stay', () => {
  const msgs = [...dmThread, { ts: '1.5', user: BOT, files: [{ name: 'render.mp4' }] }];
  const plan = planCleanup(msgs, { askTs: ['1.0', '1.3'], botUserId: BOT, threadTs: '1.0' });
  assert.ok(!plan.delete.some((d) => d.ts === '1.5'));
});

test('channel: other people\'s root and replies stay, untagged owner chat stays, only tracked asks go', () => {
  const msgs = [
    { ts: '1.0', user: 'UALEX', text: 'can someone pull the numbers' },
    { ts: '1.1', user: OWNER, text: '<@UBOT> pull them' },
    { ts: '1.2', user: BOT, text: 'on it' },
    { ts: '1.3', user: 'UALEX', text: 'thanks!' },
    { ts: '1.4', user: OWNER, text: 'np alex' },
    { ts: '1.5', user: BOT, text: 'numbers: 12' },
  ];
  const plan = planCleanup(msgs, { askTs: ['1.1'], botUserId: BOT, threadTs: '1.0' });
  assert.equal(plan.edit, '1.2');
  assert.deepEqual(plan.delete.map((d) => d.ts), ['1.1', '1.5']);
});

test('bot posts from before the first ask (stand-in answers) are neither edited nor deleted', () => {
  const msgs = [{ ts: '1.0', user: 'UALEX', text: 'q' }, { ts: '1.1', user: BOT, text: 'stand-in answer' }, { ts: '1.2', user: OWNER, text: '<@UBOT> x' }, { ts: '1.3', user: BOT, text: 'on it' }, { ts: '1.4', user: BOT, text: 'y' }];
  const plan = planCleanup(msgs, { askTs: ['1.2'], botUserId: BOT, threadTs: '1.0' });
  assert.equal(plan.edit, '1.3');
  assert.deepEqual(plan.delete.map((d) => d.ts), ['1.2', '1.4']);
});

test('a second cleanup edits the earlier summary and folds the new turn into it', () => {
  const msgs = [{ ts: '1.0', user: OWNER, text: 'x' }, { ts: '1.1', user: BOT, text: 'summary of x' }, { ts: '2.0', user: OWNER, text: 'now y' }, { ts: '2.1', user: BOT, text: 'on it' }, { ts: '2.2', user: BOT, text: 'y done' }];
  const plan = planCleanup(msgs, { askTs: ['2.0'], botUserId: BOT, threadTs: '1.0', summaryTs: '1.1' });
  assert.equal(plan.edit, '1.1');
  assert.deepEqual(plan.delete.map((d) => d.ts), ['2.0', '2.1', '2.2']);
});

test('skipped: threads started by a bot post, or with no bot message to edit', () => {
  assert.equal(planCleanup([{ ts: '1.0', user: BOT, text: 'lessons' }, { ts: '1.1', user: OWNER, text: 'forget 2' }], { askTs: ['1.1'], botUserId: BOT, threadTs: '1.0' }), null);
  assert.equal(planCleanup([{ ts: '1.0', user: OWNER, text: 'x' }], { askTs: ['1.0'], botUserId: BOT, threadTs: '1.0' }), null);
});

test('fallback summary: first ask and last real reply, word for word', () => {
  const text = fallbackSummary(dmThread, { askTs: ['1.0', '1.3'], botUserId: BOT, ownerName: 'Mitchell' });
  assert.equal(text, 'Mitchell asked: make the thing\n\nblue now: https://x.com/b');
});

function fakeSlack(messages, { failDelete } = {}) {
  const calls = { posted: [], edited: [], deleted: [] };
  const client = {
    conversations: { replies: async () => ({ messages }) },
    chat: {
      postMessage: async (a) => (calls.posted.push(a), { ts: '9.0' }),
      update: async (a) => (calls.edited.push(a), {}),
      delete: async (a) => {
        if (failDelete === a.ts) throw Object.assign(new Error('x'), { data: { error: 'ratelimited' } });
        calls.deleted.push(a);
        return {};
      },
    },
  };
  return { client, calls };
}

const cfg = (extra = {}) => ({ ownerId: OWNER, ownerName: 'Mitchell', botName: 'AI Mitchell', claudeBin: '/nonexistent/claude', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-')), userToken: 'xoxp-test', ...extra });

test('runs end to end: edits the first reply, posts nothing, deletes owner asks with the user token, resumes after a cut-off', async () => {
  const config = cfg();
  const t = { channel: 'D1', threadTs: '1.0', sessionId: 'sess', askTs: ['1.0', '1.3'], pending: [] };
  const first = fakeSlack(dmThread, { failDelete: '1.3' });
  const r1 = await runCleanup({ client: first.client, config, t, botUserId: BOT });
  assert.equal(r1.done, false, 'stopped on the rate limit');
  assert.equal(first.calls.posted.length, 0, 'never posts a new message');
  assert.equal(first.calls.edited.length, 1);
  assert.equal(first.calls.edited[0].ts, '1.1');
  assert.match(first.calls.edited[0].text, /^Mitchell asked: make the thing/);
  assert.ok(t.cleanup, 'progress saved');

  const second = fakeSlack(dmThread);
  const r2 = await runCleanup({ client: second.client, config, t, botUserId: BOT });
  assert.equal(r2.done, true);
  assert.equal(second.calls.edited.length, 0, 'not edited twice');
  assert.deepEqual(second.calls.deleted.map((d) => d.ts), ['1.3', '1.4', '1.0'], 'picks up where it stopped');
  assert.equal(second.calls.deleted.find((d) => d.ts === '1.3').token, 'xoxp-test');
  assert.equal(second.calls.deleted.find((d) => d.ts === '1.4').token, undefined, 'bot messages use the bot token');
  assert.equal(t.summaryTs, '1.1');
  assert.deepEqual(t.askTs, []);
  assert.equal(t.cleanup, null);
  assert.equal(JSON.parse(fs.readFileSync(t.archive, 'utf8')).length, 5, 'transcript archived for the lessons DM');
});

test('a new ask during the summary means nothing is edited or deleted', async () => {
  const t = { channel: 'D1', threadTs: '1.0', sessionId: 'sess', askTs: ['1.0', '1.3'], pending: [], cleanupNow: true };
  const { client, calls } = fakeSlack(dmThread);
  const r = await runCleanup({ client, config: cfg(), t, botUserId: BOT, busy: () => true });
  assert.equal(r.done, false);
  assert.equal(calls.edited.length + calls.deleted.length, 0);
  assert.equal(t.cleanup, undefined);
  assert.equal(t.cleanupNow, false, 'the new answer is not folded right after it lands');
});

test('a user token that cannot delete stops Clean Up instead of half-cleaning', async () => {
  const config = cfg({ userToken: 'xoxp-test-bad' });
  const t = { channel: 'D1', threadTs: '1.0', sessionId: 'sess', askTs: ['1.0', '1.3'], pending: [] };
  const { client, calls } = fakeSlack(dmThread);
  client.chat.delete = async (a) => {
    if (a.token) throw Object.assign(new Error('x'), { data: { error: 'missing_scope' } });
    calls.deleted.push(a);
  };
  const r = await runCleanup({ client, config, t, botUserId: BOT });
  assert.equal(r.done, false);
  assert.equal(config.userToken, '');
  assert.deepEqual(calls.deleted.map((d) => d.ts), ['1.2'], 'stopped at the first owner message');
  assert.ok(t.cleanup, 'resumes once the token is fixed');
});

test('automatic cleanups wait until the thread itself has been quiet', async () => {
  const t = { channel: 'C1', threadTs: '1.0', sessionId: 'sess', askTs: ['1.0'], pending: [] };
  const { client, calls } = fakeSlack([{ ts: '1.0', user: OWNER, text: '<@UBOT> x' }, { ts: '1.1', user: BOT, text: 'y' }, { ts: '5000.0', user: 'UALEX', text: 'nice' }]);
  const r = await runCleanup({ client, config: cfg({ cleanupAfterMin: 60 }), t, botUserId: BOT, now: 5000_000 + 30 * 60_000 });
  assert.equal(r.done, false);
  assert.equal(calls.edited.length, 0);
  assert.deepEqual(t.askTs, ['1.0'], 'still tracked for later');
});

test('a short "done" reply closes the conversation; anything more is a normal ask', async () => {
  const { DONE_REPLY, ASKS_BACK } = await import('../src/cleanup.js');
  for (const s of ["That's good", 'thats good', 'Oh, this is great', 'perfect', 'perfect, thanks!', 'thank you', 'looks good', 'lgtm', 'ok cool', 'great thanks', ':+1:', ':+1::skin-tone-3:', '👍', '👍🏻', '🙏🏽', '💯', 'love it', "we're good", 'this looks great', 'that’s perfect']) assert.ok(DONE_REPLY.test(s), s);
  for (const s of ["that's good but make it blue", 'good, now send it to alex', 'is that good?', 'great, can you also do the other one', 'thanks, post it in #launches', 'not good', 'make it perfect', 'done', "it's done", "that's it", ':-1:', ':x:', ':eyes:', ':thinking_face:']) assert.ok(!DONE_REPLY.test(s), s);
  for (const s of ['**Want me to post it?**', 'Should I send it? (draft below)', 'Post it? 👀', 'draft:\n<https://x.com|link>\nreply yes and I send it']) assert.ok(ASKS_BACK.test(s), s);
  assert.ok(!ASKS_BACK.test('• done: posted in #launches\n• checked live'));
});

test('"clean up" in a thread from before Clean Up shipped finds its asks in the thread', async () => {
  const msgs = [
    { ts: '1.0', user: OWNER, text: '<@UALEX> heads up, new campaign' },
    { ts: '1.1', user: OWNER, text: '<@UBOT> set it up' },
    { ts: '1.2', user: BOT, text: 'done' },
    { ts: '1.3', user: 'UALEX', text: 'nice' },
    { ts: '1.4', user: OWNER, text: '<@UBOT> fix it' },
    { ts: '1.5', user: BOT, text: 'fixed' },
    { ts: '1.6', user: OWNER, text: '<@UBOT> clean up' },
  ];
  const t = { channel: 'C1', threadTs: '1.0', sessionId: 'sess', askTs: ['1.6'], pending: [], cleanupNow: true };
  const { client, calls } = fakeSlack(msgs);
  const r = await runCleanup({ client, config: cfg(), t, botUserId: BOT });
  assert.equal(r.done, true);
  assert.equal(calls.edited[0].ts, '1.2');
  assert.deepEqual(calls.deleted.map((d) => d.ts), ['1.1', '1.4', '1.5', '1.6'], 'the root and the teammate stay');
});
