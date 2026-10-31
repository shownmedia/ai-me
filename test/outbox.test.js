import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { outboxDir, prepareOutbox, collectOutbox, clearOutbox, MAX_FILES } from '../src/outbox.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));

test('outbox is per thread and survives a resume but not a fresh run', () => {
  const root = tmp();
  const dir = outboxDir(root, 'D1', '123.456');
  assert.equal(path.basename(dir), 'D1-123-456');
  prepareOutbox(dir);
  fs.writeFileSync(path.join(dir, 'cut.mp4'), 'x');
  prepareOutbox(dir, { resumed: true });
  assert.ok(fs.existsSync(path.join(dir, 'cut.mp4')));
  prepareOutbox(dir);
  assert.deepEqual(fs.readdirSync(dir), []);
  clearOutbox(dir);
  assert.ok(!fs.existsSync(dir));
});

test('collect finds files in subfolders, skips junk and empty files, caps the count', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'export', '__MACOSX'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'image.png'), 'png');
  fs.writeFileSync(path.join(dir, 'export', 'video.mp4'), 'mp4');
  fs.writeFileSync(path.join(dir, 'export', '__MACOSX', 'junk'), 'j');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  fs.writeFileSync(path.join(dir, 'export.zip'), 'zip');
  fs.writeFileSync(path.join(dir, 'half.mp4.part'), 'p');
  fs.writeFileSync(path.join(dir, 'empty.png'), '');
  const { files, skipped } = collectOutbox(dir);
  assert.deepEqual(files.map((f) => f.name).sort(), ['image.png', 'video.mp4']);
  assert.deepEqual(skipped, []);
  for (let i = 0; i < MAX_FILES + 2; i++) fs.writeFileSync(path.join(dir, `f${i}.png`), 'x');
  const many = collectOutbox(dir);
  assert.equal(many.files.length, MAX_FILES);
  assert.equal(many.skipped.length, 4);
});

test('a missing outbox is just empty', () => {
  assert.deepEqual(collectOutbox('/nope/never'), { files: [], skipped: [] });
});
