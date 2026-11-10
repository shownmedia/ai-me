#!/usr/bin/env node
// PostToolUse hook for limited guest runs: every Google file the run creates or copies is shared with the
// guests' Google accounts (AI_SLACK_SHARE_TO, from guests.json `emails`) as editors, so they can always open
// what the bot made for them. Uses the gws CLI (the owner's Google login); no notification email.
import { execFile } from 'node:child_process';
import { createdFileId } from '../src/slack-guard.js';

const emails = (process.env.AI_SLACK_SHARE_TO || '').split(',').filter(Boolean);
const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
const gws = (args) => new Promise((resolve) => execFile(process.env.GWS_BIN || 'gws', args, { env: { ...process.env, PATH }, timeout: 30_000 }, (err, out, errOut) => resolve(err ? (errOut || err.message).trim().slice(0, 200) : null)));

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const { tool_name: name = '', tool_response: response } = JSON.parse(raw || '{}');
const id = /^mcp__claude_ai_Google_Drive__(create_file|copy_file)$/.test(name) ? createdFileId(response) : null;
if (!id || !emails.length) process.exit(0);
const done = [];
const failed = [];
for (const email of emails) {
  const err = await gws(['drive', 'permissions', 'create', '--params', JSON.stringify({ fileId: id, sendNotificationEmail: false, supportsAllDrives: true }), '--json', JSON.stringify({ type: 'user', role: 'writer', emailAddress: email })]);
  (err ? failed : done).push(err ? `${email} (${err})` : email);
}
const note = [done.length && `Shared this file with ${done.join(', ')} as editor.`, failed.length && `Could not share it with ${failed.join(', ')}; say so in your reply.`].filter(Boolean).join(' ');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }));
