#!/usr/bin/env node
// Dry run: see what the bot would understand and do for an ask, without touching anything.
// Builds the exact prompt the bot would (real Slack thread context, real system prompt), runs
// Claude Code in plan mode with Slack writes blocked, and prints the reply. Nothing is posted,
// changed or saved, and no session is kept.
//
//   npm run try -- <slack permalink>                  replay that message as the ask (context = what came before it)
//   npm run try -- <slack permalink> "new ask"        a new ask at the end of that thread
//   options: --model <m>  --system <file>  --prompt-only  --json
import fs from 'node:fs';
import { WebClient } from '@slack/web-api';
import { config } from '../src/config.js';
import { runClaude, SELF_PROTECT, RUN_ENV } from '../src/claude.js';
import { loadSystemPrompt, buildPrompt, gatherContext } from '../src/prompt.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const bool = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && Boolean(argv.splice(i, 1));
};
const model = flag('--model') ?? config.defaultModel;
const systemFile = flag('--system');
const promptOnly = bool('--prompt-only');
const json = bool('--json');
const [link, newAsk] = argv;
const m = /archives\/(\w+)\/p(\d{10})(\d{6})/.exec(link || '');
if (!m) {
  console.error('usage: npm run try -- <slack permalink> ["new ask"] [--model m] [--system file] [--prompt-only] [--json]');
  process.exit(2);
}
const channel = m[1];
const msgTs = `${m[2]}.${m[3]}`;
const threadTs = new URL(link).searchParams.get('thread_ts') || msgTs;

const client = new WebClient(config.botToken);
const { user_id: botUserId } = await client.auth.test();
let ask;
if (newAsk) ask = { ts: `${Math.floor(Date.now() / 1000)}.000000`, text: newAsk };
else {
  const res = await client.conversations.replies({ channel, ts: threadTs, latest: msgTs, inclusive: true, limit: 1000 });
  const msg = (res.messages || []).find((x) => x.ts === msgTs);
  if (!msg) throw new Error(`message ${msgTs} not found in ${channel}`);
  ask = { ts: msgTs, text: (msg.text || '').replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim() };
}

const t = { channel, threadTs, started: false, contextTs: null, permalink: link.split('?')[0] + `?thread_ts=${threadTs}&cid=${channel}` };
const context = await gatherContext(client, t, [ask], { botUserId, ownerId: config.ownerId, ownerName: config.ownerName, until: newAsk ? undefined : msgTs });
const prompt = buildPrompt(config, t, [ask], context.text);
const base = systemFile ? fs.readFileSync(systemFile, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => ({ BOT_NAME: config.botName, OWNER_NAME: config.ownerName, WORKDIR: config.workdir })[k] ?? '') : loadSystemPrompt(config);
const systemPrompt = `${base}

DRY RUN (a test of the Slack bot, overrides everything above): change nothing, post nothing, push nothing, deploy nothing. Read and investigate as much as you normally would, then end with exactly three labelled parts:
UNDERSTOOD: what you think ${config.ownerName} is asking, in one line, naming the specific thing (repo, file, feature).
PLAN: the steps you would take.
REPLY: the exact final message you would post to Slack.`;

if (promptOnly) {
  console.log(prompt);
  process.exit(0);
}
const started = Date.now();
const tools = [];
const res = await runClaude({
  bin: config.claudeBin,
  cwd: config.workdir,
  prompt,
  sessionId: crypto.randomUUID(),
  model,
  permissionMode: 'plan',
  systemPrompt,
  disallowedTools: [...SELF_PROTECT, 'mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Slack__slack_send_message_draft', 'mcp__claude_ai_Slack__slack_schedule_message', 'mcp__claude_ai_Slack__slack_add_reaction', 'mcp__claude_ai_Slack__slack_create_canvas', 'mcp__claude_ai_Slack__slack_update_canvas', 'Edit', 'Write', 'NotebookEdit'],
  chrome: config.chrome,
  extraArgs: `--no-session-persistence ${config.claudeExtraArgs}`,
  timeoutMin: 15,
  onProgress: (step) => tools.push(step),
  env: { ...RUN_ENV, AI_SLACK_DRY_RUN: '1' },
}).promise;
const secs = Math.round((Date.now() - started) / 1000);
if (json) console.log(JSON.stringify({ ask: ask.text, model: model || '(claude default)', secs, ok: res.ok, steps: tools, reply: res.text, contextChars: context.text.length }));
else console.log(`ask: ${ask.text}\nmodel: ${model || '(claude default)'} · ${secs}s · ${tools.length} steps · context ${context.text.length} chars\nsteps:\n${tools.map((s) => `  ${s}`).join('\n')}\n\n${res.text}`);
