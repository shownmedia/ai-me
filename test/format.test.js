import test from 'node:test';
import assert from 'node:assert/strict';
import { explainingChars } from '../src/format.js';

test('explainingChars skips code blocks, quotes and link urls', () => {
  assert.equal(explainingChars('done: sent <https://a.b/c|the message>'), 'done: sent the message'.length);
  assert.equal(explainingChars('here it is\n```\n' + 'x'.repeat(900) + '\n```\n> ' + 'y'.repeat(900)), 'here it is'.length);
  assert.ok(explainingChars('• ' + 'word '.repeat(200)) > 800);
  assert.equal(explainingChars('by pod\n| pod | launches |\n| --- | --- |\n| 1 | ' + 'z'.repeat(900) + ' |'), 'by pod'.length);
});
