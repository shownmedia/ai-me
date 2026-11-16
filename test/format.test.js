import test from 'node:test';
import assert from 'node:assert/strict';
import { explainingChars } from '../src/format.js';

test('explainingChars skips code blocks, quotes and link urls', () => {
  assert.equal(explainingChars('done: sent <https://a.b/c|the message>'), 'done: sent the message'.length);
  assert.equal(explainingChars('here it is\n```\n' + 'x'.repeat(900) + '\n```\n> ' + 'y'.repeat(900)), 'here it is'.length);
  assert.ok(explainingChars('• ' + 'word '.repeat(200)) > 800);
  assert.equal(explainingChars('by pod\n| pod | launches |\n| --- | --- |\n| 1 | ' + 'z'.repeat(900) + ' |'), 'by pod'.length);
});

test('a voice file is added to the end of the system prompt', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadSystemPrompt } = await import('../src/prompt.js');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'v.md');
  fs.writeFileSync(f, 'talk like {{OWNER_NAME}}');
  const base = { root: path.resolve(import.meta.dirname, '..'), botName: 'B', ownerName: 'Sam', workdir: '/w' };
  assert.ok(loadSystemPrompt({ ...base, voiceFile: f }).trimEnd().endsWith('talk like Sam'));
  assert.ok(!loadSystemPrompt({ ...base, voiceFile: '/nope/v.md' }).includes('talk like'));
});

test('a markdown link whose url carries a Slack label still becomes a link', async () => {
  const { toMrkdwn } = await import('../src/format.js');
  assert.equal(toMrkdwn("pick [reevo's pod](https://a.io/deals/1|Reevo deal) today"), "pick <https://a.io/deals/1|reevo's pod> today");
  assert.equal(toMrkdwn('[x](https://a.io/y)'), '<https://a.io/y|x>');
});
