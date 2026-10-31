#!/usr/bin/env node
// Saves a Slack token from the clipboard into .env without printing it.
// Usage: node bin/save-token.js SLACK_APP_TOKEN   (expects xapp-…)
//        node bin/save-token.js SLACK_BOT_TOKEN   (expects xoxb-…)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const PREFIX = { SLACK_APP_TOKEN: 'xapp-', SLACK_BOT_TOKEN: 'xoxb-' };
const key = process.argv[2];
if (!PREFIX[key]) {
  console.error('usage: node bin/save-token.js SLACK_APP_TOKEN|SLACK_BOT_TOKEN');
  process.exit(1);
}
const clip = process.platform === 'win32'
  ? execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' })
  : execFileSync('pbpaste', { encoding: 'utf8' });
const token = clip.trim();
if (!token.startsWith(PREFIX[key]) || /\s/.test(token)) {
  console.error(`The clipboard doesn't hold a ${PREFIX[key]}… token. Click Copy next to the token in Slack, then run this again.`);
  process.exit(1);
}
const file = new URL('../.env', import.meta.url);
// Replace the key where it is (`KEY=`, `KEY = `, `export KEY=`), drop any repeats, keep everything else as is.
const isKey = (l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l);
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\n$/, '').split(/\r?\n/) : [];
const at = lines.findIndex(isKey);
const out = lines.filter((l, i) => i === at || !isKey(l));
if (at === -1) out.push(`${key}=${token}`);
else out[out.findIndex(isKey)] = `${key}=${token}`;
fs.writeFileSync(file, out.join('\n') + '\n', { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`Saved ${key} (${PREFIX[key]}…${token.slice(-4)}) to .env`);
