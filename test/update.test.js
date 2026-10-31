import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { updateDue, selfUpdate, npmCli, UPDATE_EVERY_MS } from '../src/update.js';
import { loadAddons } from '../src/extensions.js';

// A fake git: answers by subcommand, records every call.
function fakeGit(answers) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const a = answers[cmd !== 'git' ? 'npm' : args[0] === 'rev-parse' ? `rev-parse ${args[1]}` : args[0]];
    if (a instanceof Error) throw a;
    return a ?? '';
  };
  return { run, calls };
}

test('updateDue: first time, then every 6 hours', () => {
  assert.equal(updateDue(undefined, 1000), true);
  assert.equal(updateDue(1000, 1000 + UPDATE_EVERY_MS - 1), false);
  assert.equal(updateDue(1000, 1000 + UPDATE_EVERY_MS), true);
});

test('selfUpdate: up to date does nothing', () => {
  const g = fakeGit({ 'rev-parse HEAD': 'aaa', 'rev-parse @{u}': 'aaa' });
  assert.equal(selfUpdate({ root: '.', run: g.run, log: () => {} }), false);
  assert.ok(!g.calls.some((c) => c.includes('merge')));
});

test('selfUpdate: fast-forwards when behind and asks for a restart', () => {
  const g = fakeGit({ 'rev-parse HEAD': 'aaa1111', 'rev-parse @{u}': 'bbb2222', diff: 'src/index.js' });
  const logs = [];
  assert.equal(selfUpdate({ root: '.', run: g.run, log: (l) => logs.push(l) }), true);
  assert.ok(g.calls.includes('git merge --ff-only --quiet @{u}'));
  assert.match(logs[0], /aaa1111 -> bbb2222/);
});

// A throwaway checkout folder with a node_modules, for the package-swap tests.
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  fs.mkdirSync(path.join(root, 'node_modules', 'old-pkg'), { recursive: true });
  return root;
}

test('selfUpdate: new packages are staged, then swapped in before the restart', () => {
  const root = tmpRoot();
  const g = fakeGit({ 'rev-parse HEAD': 'aaa', 'rev-parse @{u}': 'bbb', diff: 'package-lock.json\nsrc/x.js', show: '{}' });
  const run = (cmd, args) => {
    if (cmd !== 'git') fs.mkdirSync(path.join(args[args.indexOf('--prefix') + 1], 'node_modules', 'new-pkg'), { recursive: true });
    return g.run(cmd, args);
  };
  assert.equal(selfUpdate({ root, run, npm: '/n/npm-cli.js', log: () => {} }), true);
  assert.ok(g.calls.some((c) => c.includes('/n/npm-cli.js ci --omit=dev --silent --prefix')));
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'new-pkg')));
  assert.ok(!fs.existsSync(path.join(root, 'node_modules.old')));
});

test('selfUpdate: a failed package install changes nothing', () => {
  const root = tmpRoot();
  const g = fakeGit({ 'rev-parse HEAD': 'aaa', 'rev-parse @{u}': 'bbb', diff: 'package-lock.json', show: '{}', npm: new Error('EPERM') });
  const logs = [];
  assert.equal(selfUpdate({ root, run: g.run, npm: '/n/npm-cli.js', log: (l) => logs.push(l) }), false);
  assert.ok(!g.calls.some((c) => c.startsWith('git merge ')));
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'old-pkg')));
  assert.match(logs[0], /staying on aaa/);
});

test('selfUpdate: no npm means no update when packages changed', () => {
  const g = fakeGit({ 'rev-parse HEAD': 'aaa', 'rev-parse @{u}': 'bbb', diff: 'package-lock.json' });
  assert.equal(selfUpdate({ root: '.', run: g.run, npm: null, log: () => {} }), false);
  assert.ok(!g.calls.some((c) => c.startsWith('git merge ')));
});

test('selfUpdate: never overwrites local commits', () => {
  const g = fakeGit({ 'rev-parse HEAD': 'aaa', 'rev-parse @{u}': 'bbb', 'merge-base': new Error('diverged') });
  assert.equal(selfUpdate({ root: '.', run: g.run, log: () => {} }), false);
  assert.ok(!g.calls.some((c) => c.startsWith('git merge ')));
});

test('selfUpdate: offline or no git is a quiet skip', () => {
  const g = fakeGit({ fetch: Object.assign(new Error('x'), { stderr: 'fatal: unable to access' }) });
  const logs = [];
  assert.equal(selfUpdate({ root: '.', run: g.run, log: (l) => logs.push(l) }), false);
  assert.match(logs[0], /skipped: fatal: unable to access/);
});

test('npmCli finds npm next to node', () => {
  const node = path.join('/x', 'bin', 'node');
  assert.equal(npmCli(node, (p) => p === path.join('/x', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')), path.join('/x', 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.equal(npmCli(node, () => false), undefined);
});

test('loadAddons: no add-ons file means a no-op set', async () => {
  const none = await loadAddons({}, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'addons-')), 'addons.js'));
  assert.equal(none.scope('C1', 'U1', '1.1'), null);
  assert.equal(none.systemPrompt({}), '');
  assert.doesNotThrow(() => none.start({}));
});
