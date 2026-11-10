import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { runClaude, buildArgs, estimateTask, parseEstimate, windowsClaude, READER_TOOLS, readerSettings } from '../src/claude.js';
import { slackGuard, createdFileId } from '../src/slack-guard.js';
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

test('anywhere guests: any DM, channel or thread, only listed users; thread entries still win', () => {
  const g = [{ channel: 'C1', thread_ts: '1.2', users: ['UB'], workdir: '~/p' }, { anywhere: true, users: ['UM'], limited: true }];
  assert.equal(guestFor(g, 'D9', undefined, 'UM')?.limited, true);
  assert.equal(guestFor(g, 'C7', '5.5', 'UM')?.limited, true);
  assert.equal(guestFor(g, 'C1', '1.2', 'UM'), null, 'a listed thread only takes its own users');
  assert.equal(guestFor(g, 'D9', undefined, 'UX'), null);
  assert.equal(guestThread(g, 'D9', '5.5'), null, 'anywhere entries never scope the owner');
  assert.equal(guestFor([{ anywhere: true, users: ['UM'] }], 'D9', undefined, 'UM'), null, 'anywhere without limited is ignored');
});

test('limited runs: --settings is passed through, only the allowed tools', () => {
  const args = buildArgs({ prompt: 'p', sessionId: 's', permissionMode: 'dontAsk', settings: '{"hooks":{}}' });
  assert.deepEqual(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2), ['--settings', '{"hooks":{}}']);
  assert.ok(!buildArgs({ prompt: 'p', sessionId: 's', permissionMode: 'dontAsk' }).includes('--settings'));
  assert.ok(JSON.parse(readerSettings()).hooks.PreToolUse[0].hooks[0].command.includes('slack-guard.js'));
  const post = JSON.parse(readerSettings()).hooks.PostToolUse[0];
  assert.ok(post.hooks[0].command.includes('share-created.js') && new RegExp(post.matcher).test('mcp__claude_ai_Google_Drive__copy_file') && !new RegExp(`^(${post.matcher})$`).test('mcp__claude_ai_Google_Drive__share_file'));
});

test('createdFileId: the new file id from a Drive create/copy response in any shape', () => {
  const file = { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', title: 'x', parents: ['0B9parentFolderIdxxxxxxxx'] };
  assert.equal(createdFileId(file), file.id);
  assert.equal(createdFileId(JSON.stringify(file)), file.id);
  assert.equal(createdFileId([{ type: 'text', text: JSON.stringify(file) }]), file.id, 'MCP content blocks (escaped JSON)');
  assert.equal(createdFileId({ driveId: '0AparentDriveIdxxxxxxxxxxx' }), null);
  assert.equal(createdFileId(undefined), null);
  assert.ok(READER_TOOLS.every((t) => ['ToolSearch', 'Read', 'Grep', 'mcp__claude_ai_Melius'].includes(t) || /^mcp__claude_ai_(Slack__slack_(search_public|read_channel|read_thread|search_users|read_user_profile)|Gmail__|Google_)/.test(t)));
  assert.ok(!READER_TOOLS.some((t) => /send_message|Gmail__(send|forward|reply|trash)|share_file|trash_file|create_event|update_event|delete/.test(t)), 'no sends, shares, invites or deletes');
});

test('slack guard: public channels and the asker\'s private channels only, never DMs', async () => {
  const chans = { C1: { is_private: false }, G2: { is_private: true }, C3: { is_private: true }, C4: { is_mpim: true } };
  const slack = { info: async (id) => chans[id] || null, members: async (id) => (id === 'G2' ? ['UM', 'UX'] : ['UX']) };
  const call = (tool, input = {}) => slackGuard({ tool_name: `mcp__claude_ai_Slack__${tool}`, tool_input: input }, ['UM'], slack);
  assert.equal(await call('slack_search_public', { query: 'x' }), null);
  assert.equal(await call('slack_search_public', { query: 'x', content_types: 'messages' }), null);
  assert.match(await call('slack_search_public', { query: 'x', content_types: 'messages,files' }), /File search/);
  assert.equal(await slackGuard({ tool_name: 'ToolSearch', tool_input: {} }, ['UM'], slack), null);
  assert.match(await slackGuard({ tool_name: 'ReadMcpResourceTool', tool_input: {} }, ['UM'], slack), /not available/);
  assert.match(await slackGuard({ tool_name: 'Bash', tool_input: {} }, ['UM'], slack), /not available/);
  const saved = path.join(os.homedir(), '.claude/projects/-private-var-T-ai-slack-reader/eab9d938-0dbe/tool-results/doc.txt');
  assert.equal(await slackGuard({ tool_name: 'Read', tool_input: { file_path: saved } }, ['UM'], slack), null);
  assert.match(await slackGuard({ tool_name: 'Read', tool_input: { file_path: path.join(os.homedir(), '.shown/env') } }, ['UM'], slack), /only works/);
  assert.match(await slackGuard({ tool_name: 'Read', tool_input: { file_path: `${saved}/../../../../-Users-mitchell/memory/MEMORY.md` } }, ['UM'], slack), /only works/);
  assert.match(await slackGuard({ tool_name: 'Grep', tool_input: { pattern: 'x' } }, ['UM'], slack), /only works/);
  assert.match(await slackGuard({ tool_name: 'Read', tool_input: { file_path: path.join(os.homedir(), '.claude/projects/-Users-mitchell/x/tool-results/a.txt') } }, ['UM'], slack), /only works/);
  assert.equal(await call('slack_read_channel', { channel_id: 'C1' }), null);
  assert.equal(await call('slack_read_thread', { channel_id: 'G2', message_ts: '1.2' }), null);
  assert.match(await call('slack_read_channel', { channel_id: 'C3' }), /not in/);
  assert.match(await call('slack_read_channel', { channel_id: 'C4' }), /DMs/);
  assert.match(await call('slack_read_channel', { channel_id: 'D123' }), /DMs/);
  assert.match(await call('slack_read_channel', { channel_id: 'U0OWNER01' }), /DMs/, 'a user id reads a DM');
  assert.match(await call('slack_read_channel', { channel_id: 'C9' }), /not a channel/, 'unknown or bot not in it');
  assert.match(await call('slack_search_public_and_private', { query: 'x' }), /not available/);
  assert.match(await call('slack_send_message', { channel_id: 'C1' }), /not available/);
  assert.equal(await slackGuard({ tool_name: 'mcp__claude_ai_Gmail__search_threads', tool_input: {} }, ['UM'], slack), null);
  assert.equal(await slackGuard({ tool_name: 'mcp__claude_ai_Google_Docs__read_doc', tool_input: {} }, ['UM'], slack), null);
  assert.match(await slackGuard({ tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: {} }, ['UM'], slack), /not available/);
  assert.match(await slackGuard({ tool_name: 'mcp__claude_ai_Google_Drive__share_file', tool_input: {} }, ['UM'], slack), /not available/);
  assert.match(await slackGuard({ tool_name: 'mcp__claude_ai_Google_Calendar__create_event', tool_input: {} }, ['UM'], slack), /not available/);
  assert.equal(await slackGuard({ tool_name: 'mcp__claude_ai_Melius__node_create', tool_input: {} }, ['UM'], slack), null);
  assert.match(await slackGuard({ tool_name: 'mcp__claude_ai_Melius__canvas_delete', tool_input: {} }, ['UM'], slack), /off/);
  assert.match(await slackGuard({ tool_name: 'mcp__shownroom__set_ticket_status', tool_input: {} }, ['UM'], slack), /not available/);
  assert.match(await slackGuard({ tool_name: 'mcp__claude_ai_Slack__slack_read_channel', tool_input: { channel_id: 'G2' } }, [], slack), /not in/, 'no readers fails closed');
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
