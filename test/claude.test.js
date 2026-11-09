import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { runClaude, buildArgs, estimateTask, parseEstimate, windowsClaude } from '../src/claude.js';
import { editedReply, toMrkdwn, chunk, describeTool, lowercase, parseLinks, commsText, parseComms, commsReply, threadsWithNewReplies, guestFor, guestThread } from '../src/format.js';

const bin = [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.js')];
const base = { bin, cwd: process.cwd(), prompt: 'hi', sessionId: 'sess-1', model: 'sonnet', permissionMode: 'bypassPermissions', timeoutMin: 1 };
const run = (opts = {}, mode = 'ok') => runClaude({ ...base, ...opts, env: { FAKE_MODE: mode } }).promise;

test('bypass mode uses --dangerously-skip-permissions; first run pins the session id', () => {
  const a = buildArgs({ ...base, resume: false });
  assert.ok(a.includes('--dangerously-skip-permissions'));
  assert.ok(!a.includes('--permission-mode'));
  assert.equal(a[a.indexOf('--session-id') + 1], 'sess-1');
  const b = buildArgs({ ...base, resume: true, permissionMode: 'auto' });
  assert.equal(b[b.indexOf('--resume') + 1], 'sess-1');
  assert.equal(b[b.indexOf('--permission-mode') + 1], 'auto');
});

test('success returns the final result, cost and progress', async () => {
  const steps = [];
  const res = await run({ onProgress: (s) => steps.push(s) });
  assert.equal(res.ok, true);
  assert.equal(res.sessionStarted, true);
  assert.match(res.text, /^Done\./);
  assert.equal(res.costUsd, 0.42);
  assert.deepEqual(steps, ['Running `git push`']);
});

test('a crash still produces a reply with the error, never a throw', async () => {
  const res = await run({}, 'crash');
  assert.equal(res.ok, false);
  assert.match(res.text, /boom: something exploded/);
});

test('a missing binary still produces a reply', async () => {
  const res = await run({ bin: '/nope/claude' });
  assert.equal(res.ok, false);
  assert.match(res.text, /Could not start Claude Code|exited/);
});

test('resuming a deleted session is detectable so the bot can start fresh', async () => {
  const res = await run({ resume: true }, 'missing-session');
  assert.equal(res.sessionStarted, false);
  assert.match(res.text, /No conversation found/);
});

test('stop() ends a hung run and marks it stopped', async () => {
  const r = runClaude({ ...base, env: { FAKE_MODE: 'hang' } });
  setTimeout(() => r.stop(), 300);
  const res = await r.promise;
  assert.equal(res.stopped, true);
  assert.equal(res.ok, false);
});

test('slack formatting', () => {
  assert.equal(toMrkdwn('**bold** and [link](https://x.com)'), '*bold* and <https://x.com|link>');
  assert.equal(toMrkdwn('## Heading\n- item'), '*Heading*\n• item');
  assert.equal(toMrkdwn('```js\n**not bold**\n```'), '```\n**not bold**\n```');
  const parts = chunk('a\n'.repeat(5000), 3500);
  assert.ok(parts.length >= 3 && parts.every((p) => p.length <= 3500));
  assert.equal(describeTool('Edit', { file_path: '/Users/bob/x/y.js' }), 'Editing ~/x/y.js');
});

test('session start is reported as soon as Claude confirms it, and a reused id is detectable', async () => {
  let started = 0;
  const res = await run({ onSessionStart: () => started++ });
  assert.equal(started, 1);
  assert.equal(res.ok, true);
  const inUse = await run({}, 'in-use');
  assert.equal(inUse.sessionStarted, false);
  assert.match(inUse.text, /already in use/);
  const resumed = await run({ resume: true }, 'in-use');
  assert.equal(resumed.ok, true);
});

test('estimate gives minutes and a model, and falls back to nulls', async () => {
  assert.deepEqual(await estimateTask({ bin, task: 'x' }), { minutes: 12, model: 'opus' });
  assert.deepEqual(await estimateTask({ bin: '/nope/claude', task: 'x' }), { minutes: null, model: null });
});

test('estimate parsing is tolerant', () => {
  assert.deepEqual(parseEstimate('3 sonnet'), { minutes: 3, model: 'sonnet' });
  assert.deepEqual(parseEstimate('About 20 minutes. Opus.'), { minutes: 20, model: 'opus' });
  assert.deepEqual(parseEstimate('240'), { minutes: 60, model: null });
  assert.deepEqual(parseEstimate(''), { minutes: null, model: null });
});

test('chrome flag turns on Claude in Chrome only when asked', () => {
  assert.ok(buildArgs({ ...base, resume: false, chrome: true }).includes('--chrome'));
  assert.ok(!buildArgs({ ...base, resume: false }).includes('--chrome'));
});

test('self-protect: disallowed tools are passed to Claude Code', () => {
  const a = buildArgs({ ...base, resume: false, disallowedTools: ['Bash(launchctl:*)', 'Bash(pkill:*)'] });
  const i = a.indexOf('--disallowedTools');
  assert.ok(i > 0);
  assert.deepEqual(a.slice(i + 1, i + 3), ['Bash(launchctl:*)', 'Bash(pkill:*)']);
});

test('lowercase keeps code, links and mentions intact', () => {
  assert.equal(
    lowercase('Done. Pushed `ABC123` to <https://GitHub.com/X|PR 431> for <@UOWNER123>, see https://Example.com/A\n```\nNPM Test\n```'),
    'done. pushed `ABC123` to <https://GitHub.com/X|PR 431> for <@UOWNER123>, see https://Example.com/A\n```\nNPM Test\n```',
  );
});

test('tables become aligned code blocks', () => {
  const out = toMrkdwn('Results:\n| Test | Result |\n|---|---|\n| **stop** | PASS |\n| tags | FAIL |\nDone');
  assert.equal(out, 'Results:\n```\nTest  Result\nstop  PASS\ntags  FAIL\n```\nDone');
});

test('a code block split across messages is closed and reopened', () => {
  const body = '```\n' + Array.from({ length: 1200 }, (_, i) => i + 1).join('\n') + '\n```';
  const parts = chunk(body);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.equal((p.match(/```/g) || []).length % 2, 0, 'every message has balanced fences');
    assert.ok(p.length <= 3500);
  }
  assert.equal(parts.join('\n').replace(/\n```\n```\n/g, '\n'), body);
});

test('windows: prefers claude.exe, and turns the npm .cmd shim into node + its entry point', () => {
  assert.equal(windowsClaude(['C:\\a\\claude.cmd', 'C:\\b\\claude.exe']), 'C:\\b\\claude.exe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-'));
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
  assert.deepEqual(windowsClaude([path.join(dir, 'claude'), path.join(dir, 'claude.cmd')], 'node'), ['node', path.join(pkg, 'cli.js')]);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
  assert.equal(windowsClaude([path.join(dir, 'claude.cmd')]), path.join(pkg, 'bin', 'claude.exe'));
  assert.equal(windowsClaude([]), 'claude.exe');
});

test('parseLinks + commsText build the !comms reply', () => {
  const links = parseLinks('matt: channels, not dms|https://x.slack.com/a/p1?t=1&c=2; mitchell: threads|https://x.slack.com/b/p2;junk|notaurl');
  assert.deepEqual(links, [
    { label: 'matt: channels, not dms', url: 'https://x.slack.com/a/p1?t=1&c=2' },
    { label: 'mitchell: threads', url: 'https://x.slack.com/b/p2' },
  ]);
  assert.equal(commsText(links), '• <https://x.slack.com/a/p1?t=1&c=2|matt: channels, not dms>\n• <https://x.slack.com/b/p2|mitchell: threads>');
  assert.equal(commsText(links.slice(1)), '<https://x.slack.com/b/p2|mitchell: threads>');
  assert.equal(commsText(links.slice(1), 'hey'), 'hey\n<https://x.slack.com/b/p2|mitchell: threads>');
  assert.deepEqual(parseLinks(''), []);
});

test('parseComms: only the bare command counts, a sentence about it is a normal ask', () => {
  assert.deepEqual(parseComms('!comms', 'UB'), { users: [], kind: null });
  assert.deepEqual(parseComms('<@UB> !comms <@U1|tony> <@U2>', 'UB'), { users: ['U1', 'U2'], kind: null });
  assert.deepEqual(parseComms('!comms @<@U1> dms', 'UB'), { users: ['U1'], kind: 'dm' });
  assert.deepEqual(parseComms('<@UB|AI> !comms threads *Sent using* <@UC|Claude>', 'UB'), { users: [], kind: 'thread' });
  assert.equal(parseComms('<@UB> For this message, can you have it be so that when I do !comms and tag the person', 'UB'), null);
  assert.equal(parseComms('<@UB> can you add !comms command that links this', 'UB'), null);
  assert.equal(parseComms('!commsy', 'UB'), null);
});

test('commsReply tags people and picks the DM or thread reminder', () => {
  const comms = {
    dm: { text: 'work talk goes in channels, not DMs', links: [{ label: 'matt', url: 'https://x/a' }] },
    thread: { text: 'messages should be in threads, not new messages', links: [{ label: 'mitchell', url: 'https://x/b' }] },
  };
  assert.equal(commsReply({ users: ['U1'], channel: 'C1', channelType: 'channel' }, comms), 'Hey <@U1>, quick reminder that <https://x/b|messages should be in threads, not new messages>');
  assert.equal(commsReply({ users: [], channel: 'D1' }, comms), 'Hey, quick reminder that <https://x/a|work talk goes in channels, not DMs>');
  assert.equal(commsReply({ users: ['U1', 'U2'], channel: 'C9', channelType: 'mpim' }, comms), 'Hey <@U1> <@U2>, quick reminder that <https://x/a|work talk goes in channels, not DMs>');
  assert.equal(commsReply({ users: [], kind: 'dm', channel: 'C1', channelType: 'channel' }, comms), 'Hey, quick reminder that <https://x/a|work talk goes in channels, not DMs>');
  const two = { ...comms, thread: { text: 'reply in threads', links: [{ label: 'a', url: 'https://x/1' }, { label: 'b', url: 'https://x/2' }] } };
  assert.equal(commsReply({ channel: 'C1' }, two), 'Hey, quick reminder that reply in threads\n• <https://x/1|a>\n• <https://x/2|b>');
});

test('threadsWithNewReplies finds untracked threads with replies after a point', () => {
  const msgs = [
    { ts: '100.1', reply_count: 3, latest_reply: '205.0' },
    { ts: '101.1', reply_count: 2, latest_reply: '150.0' },
    { ts: '102.1' },
    { ts: '103.1', reply_count: 1, latest_reply: '300.0' },
  ];
  assert.deepEqual(threadsWithNewReplies(msgs, '200.0', (ts) => ts === '103.1'), ['100.1']);
  assert.deepEqual(threadsWithNewReplies([], '1'), []);
});

test('guest threads: only listed users, only in the listed thread', () => {
  const g = [{ channel: 'C1', thread_ts: '1.2', users: ['UA', 'UB'], workdir: '~/p', project: 'p' }];
  assert.equal(guestFor(g, 'C1', '1.2', 'UA')?.workdir, '~/p');
  assert.equal(guestFor(g, 'C1', '1.2', 'UX'), null);
  assert.equal(guestFor(g, 'C1', '9.9', 'UA'), null);
  assert.equal(guestFor(g, 'C2', '1.2', 'UA'), null);
  assert.equal(guestThread(g, 'C1', '1.2')?.project, 'p');
  assert.equal(guestFor('not a list', 'C1', '1.2', 'UA'), null);
});

test('edit in place: answers stack under the message until it would overflow', () => {
  assert.deepEqual(editedReply('', 'a'), { edit: 'a', extra: [] });
  assert.deepEqual(editedReply('old', 'new'), { edit: 'old\n\nnew', extra: [] });
  const long = 'x'.repeat(40);
  assert.deepEqual(editedReply('old', long, 30).edit, 'old', 'old text stays, answer goes in new messages');
  assert.ok(editedReply('old', long, 30).extra.length >= 2);
  assert.equal(editedReply('', long, 30).extra.length >= 1, true);
  assert.deepEqual(editedReply('', ''), { edit: '', extra: [] }, 'callers must never pass an empty answer');
});

test('newMessage: [new] or a Drive link not linked yet posts a new message', async () => {
  const { newMessage } = await import('../src/format.js');
  assert.deepEqual(newMessage('[new]\n- done: <https://x.com|x>'), { text: '- done: <https://x.com|x>', fresh: true });
  assert.equal(newMessage('- fixed the typo').fresh, false);
  const doc = 'https://docs.google.com/document/d/1VRqdY_YNx4kwtz8SHH0IhCDsTusIra3EcQ2GXfVyIiI/edit';
  assert.equal(newMessage(`- doc: <${doc}|doc>`).fresh, true);
  assert.equal(newMessage(`- revised: <${doc}?tab=t.abc|doc>`, `- doc: <${doc}|doc>`).fresh, false);
  assert.equal(newMessage('- video: https://drive.google.com/file/d/1Kb2Rq0bsrGoWn-BsJK3vNRJPx9_ow5Do/view').fresh, true);
});
