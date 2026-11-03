import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadsToReview, ownerAsks, parseLessons, formatLessons, savePrompt, lessonsDue, memoryIndexPath, LESSONS_HEADER } from '../src/lessons.js';

test('reviews recent, started, non-guest threads only', () => {
  const now = Date.now();
  const threads = {
    a: { channel: 'D1', lastActivity: now, started: true },
    b: { channel: 'C1', lastActivity: now - 3 * 86400_000, started: true },
    c: { channel: 'C2', lastActivity: now, started: true, guest: { workdir: '~/x' } },
    d: { channel: 'C3', lastActivity: now, started: false },
  };
  assert.deepEqual(threadsToReview(threads, { since: now - 86400_000 }).map((t) => t.channel), ['D1']);
});

test('owner asks: every owner message in a DM, only tagged ones in a channel', () => {
  const since = 0;
  const msgs = [
    { user: 'UOWNER', ts: '1.0', text: 'fix it' },
    { user: 'UOWNER', ts: '2.0', text: '<@UBOT> no, the other one' },
    { user: 'UOTHER', ts: '3.0', text: '<@UBOT> hi' },
  ];
  assert.equal(ownerAsks(msgs, { ownerId: 'UOWNER', botUserId: 'UBOT', channel: 'D1', since }).length, 2);
  assert.equal(ownerAsks(msgs, { ownerId: 'UOWNER', botUserId: 'UBOT', channel: 'C1', since }).length, 1);
});

test('lessons parse strictly and format with thread links', () => {
  const raw = 'here: {"lessons":[{"rule":"Use Google Calendar for launch dates","why":"said lumen was wrong","thread":1},{"rule":"","thread":1},{"rule":"x","thread":9}]}';
  const lessons = parseLessons(raw, 2);
  assert.deepEqual(lessons, [{ rule: 'Use Google Calendar for launch dates', why: 'said lumen was wrong', thread: 1 }]);
  const text = formatLessons(lessons, ['https://x.slack.com/archives/D1/p1']);
  assert.ok(text.startsWith(LESSONS_HEADER));
  assert.match(text, /1\. \*Use Google Calendar for launch dates\*/);
  assert.match(text, /<https:\/\/x\.slack\.com\/archives\/D1\/p1\|thread>/);
  assert.deepEqual(parseLessons('not json', 2), []);
});

test('lessons run once a day after the hour', () => {
  const at = (h) => new Date(2026, 9, 17, h, 5);
  assert.equal(lessonsDue(null, 21, at(20)), null);
  assert.equal(lessonsDue(null, 21, at(21)), '2026-10-17');
  assert.equal(lessonsDue('2026-10-17', 21, at(23)), null);
  assert.equal(lessonsDue('2026-10-16', 21, at(22)), '2026-10-17');
});

test('memory index path matches how Claude Code names project folders', () => {
  assert.match(memoryIndexPath('/Users/me'), /\.claude[\\/]projects[\\/]-Users-me[\\/]memory[\\/]MEMORY\.md$/);
});

test('auto-saved lessons say so and the save prompt lists them', () => {
  const lessons = [{ rule: 'No tables in docs', why: 'hard to read', thread: 1 }];
  assert.match(formatLessons(lessons, [], true), /i saved these/);
  assert.match(savePrompt(lessons, '/m'), /1\. No tables in docs \(from: hard to read\)/);
});
