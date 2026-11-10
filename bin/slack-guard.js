#!/usr/bin/env node
// PreToolUse hook for limited guest runs (src/slack-guard.js decides). Reads the tool call on stdin;
// exit 2 with a reason on stderr refuses it. Fails closed: no token, a Slack error, bad input, a slow
// Slack (a hard deadline well under the hook's 30s timeout, since a killed hook lets the call through)
// or even a failed import all refuse.
const refuse = (reason) => {
  process.stderr.write(reason);
  process.exit(2);
};
setTimeout(() => refuse('The channel check took too long, so this read was refused.'), 20_000).unref();
process.on('uncaughtException', (err) => refuse(`The channel check failed (${err.message}), so this read was refused.`));
process.on('unhandledRejection', (err) => refuse(`The channel check failed (${err?.message || err}), so this read was refused.`));

const token = process.env.SLACK_BOT_TOKEN;
const readers = (process.env.AI_SLACK_READERS || '').split(',').filter(Boolean);

async function api(method, params) {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
  const body = await res.json();
  return body.ok ? body : null;
}

const slack = {
  info: async (channel) => (await api('conversations.info', { channel }))?.channel || null,
  async members(channel) {
    const ids = [];
    let cursor = '';
    do {
      const page = await api('conversations.members', { channel, limit: '1000', ...(cursor ? { cursor } : {}) });
      if (!page) return null;
      ids.push(...page.members);
      cursor = page.response_metadata?.next_cursor || '';
    } while (cursor);
    return ids;
  },
};

try {
  const { slackGuard } = await import('../src/slack-guard.js');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const reason = token ? await slackGuard(JSON.parse(raw), readers, slack) : 'The channel check is not set up (no Slack token), so nothing can be read.';
  if (reason) refuse(reason);
  process.exit(0);
} catch (err) {
  refuse(`The channel check failed (${err.message}), so this read was refused.`);
}
