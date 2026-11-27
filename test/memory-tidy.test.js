import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupMemory, tidyPrompt, KEEP_BACKUPS, INDEX_BUDGET } from '../src/memory-tidy.js';

test('backup copies only .md files and keeps the last 14 nights', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-'));
  const mem = path.join(tmp, 'memory'); const root = path.join(tmp, 'backups');
  fs.mkdirSync(mem); fs.mkdirSync(path.join(mem, '.obsidian'));
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'index'); fs.writeFileSync(path.join(mem, 'feedback_x.md'), 'rule');
  fs.mkdirSync(root);
  for (let i = 1; i <= 20; i++) fs.mkdirSync(path.join(root, `2026-10-${String(i).padStart(2, '0')}`));
  const dest = backupMemory(mem, root, '2026-11-26');
  assert.deepEqual(fs.readdirSync(dest).sort(), ['MEMORY.md', 'feedback_x.md']);
  const left = fs.readdirSync(root).sort();
  assert.equal(left.length, KEEP_BACKUPS);
  assert.equal(left.at(-1), '2026-11-26');
});

test('prompt names the folder, the budget and the never-lose-a-rule guard', () => {
  const p = tidyPrompt('/m', 'Mitchell');
  assert.match(p, /\/m/);
  assert.match(p, new RegExp(String(INDEX_BUDGET)));
  assert.match(p, /lose a rule/);
});
