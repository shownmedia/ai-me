import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// The 2026-11-21 outage: Slack's default reconnect retry waits 1.3x longer after every failure with no cap,
// so after ~4h offline the next reconnect was hours away. Ours must keep retrying, never waiting > 30s.
test('the Slack reconnect retry is capped at 30s and keeps going for days', () => {
  const env = { ...process.env, SLACK_BOT_TOKEN: 'x', SLACK_APP_TOKEN: 'x', OWNER_SLACK_ID: 'U1', CLAUDE_BIN: 'claude' };
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import(process.argv[1]).then((m) => process.stdout.write(JSON.stringify(m.config.connectRetry)))", new URL('../src/config.js', import.meta.url).href], { env, encoding: 'utf8' });
  const { retries, factor, minTimeout = 1000, maxTimeout } = JSON.parse(out);
  // The wait before try n, as the retry library (p-retry -> retry) computes it without randomize.
  const waits = Array.from({ length: retries }, (_, n) => Math.min(minTimeout * factor ** n, maxTimeout ?? Infinity));
  assert.ok(Math.max(...waits) <= 30_000);
  assert.ok(waits.reduce((a, b) => a + b, 0) > 2 * 24 * 3600_000);
});
