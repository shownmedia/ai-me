#!/usr/bin/env node
// Stands in for the claude CLI in tests. Behaviour is picked by FAKE_MODE.
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const mode = process.env.FAKE_MODE || 'ok';
const sessionId = args[args.indexOf('--resume') + 1] || args[args.indexOf('--session-id') + 1];

if (args.includes('--no-session-persistence')) {
  process.stdout.write(JSON.stringify({ type: 'result', result: mode === 'crash' ? 'no idea' : '12 opus' }));
  process.exit(0);
}
if (mode === 'missing-session' && args.includes('--resume')) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}
if (mode === 'in-use' && args.includes('--session-id')) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
  process.exit(1);
}
if (mode === 'crash') {
  process.stderr.write('boom: something exploded\n');
  process.exit(1);
}
out({ type: 'system', subtype: 'init', session_id: sessionId });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'git push' } }] } });
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. Pushed abc123.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: `Done. args=${JSON.stringify(args.filter((a) => a.startsWith('--')))}`, total_cost_usd: 0.42, permission_denials: [] });
}
