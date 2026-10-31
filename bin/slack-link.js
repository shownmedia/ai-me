#!/usr/bin/env node
// Prints a link that opens Slack's "Create from a manifest" dialog already filled in for this bot.
// Usage: node bin/slack-link.js "AI Sam" "Sam"
import fs from 'node:fs';

const [botName, ownerName] = process.argv.slice(2);
if (!botName || !ownerName) {
  console.error('usage: node bin/slack-link.js "<bot name>" "<owner first name>"');
  process.exit(1);
}
// Fill the names into the parsed values (not the raw text), so quotes or backslashes in a name are safe.
const fill = (v) =>
  typeof v === 'string' ? v.replaceAll('{{BOT_NAME}}', botName).replaceAll('{{OWNER_NAME}}', ownerName)
  : Array.isArray(v) ? v.map(fill)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
  : v;
const manifest = fill(JSON.parse(fs.readFileSync(new URL('../slack-manifest.json', import.meta.url), 'utf8')));
console.log(`https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`);
