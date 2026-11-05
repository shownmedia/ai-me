// Lessons: once a day, read the threads where the owner had to correct the bot, and DM the owner a
// short numbered list of rules worth remembering. Nothing is saved on its own: the owner replies
// "save 1 3" (or "save all") in that DM thread, which is an ordinary task, and that run writes the
// memories. So a correction made once doesn't have to be made again next week.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askClaude, runClaude, RUN_ENV, SELF_PROTECT } from './claude.js';
import { renderContext } from './context.js';
import { readArchive } from './cleanup.js';

export const LESSONS_HEADER = "lessons from today's threads";

// Threads worth reviewing: active since `since`, not a guest thread, with at least two asks from the
// owner (a follow-up is where corrections live). `asks` counts owner messages addressed to the bot.
export function threadsToReview(threads, { since }) {
  return Object.values(threads).filter((t) => !t.guest && (t.lastActivity || 0) >= since && t.started);
}

export function ownerAsks(messages, { ownerId, botUserId, channel, since }) {
  return messages.filter((m) => m.user === ownerId && Number(m.ts) * 1000 >= since && (channel.startsWith('D') || (m.text || '').includes(`<@${botUserId}>`)));
}

// Where Claude Code keeps the memory index for sessions started in `workdir`.
export function memoryIndexPath(workdir) {
  return path.join(os.homedir(), '.claude', 'projects', workdir.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
}

export function lessonsPrompt(transcripts, memoryIndex, ownerName) {
  return `You review an AI assistant's Slack threads with ${ownerName}, its owner, to find lessons worth remembering.

A lesson is a durable rule that a future run would get wrong again without being told: where some data really lives ("launch dates come from Google Calendar, not Lumen"), a preference about output or process ("dropdown, not an emoji reaction" only counts if it is a general preference), or a standing fact about people or tools. Only take lessons from ${ownerName} correcting or redirecting the assistant, or stating a rule. Not one-off task details, not things the assistant already got right, and nothing already covered by the memory index below.

Be strict: zero lessons is the normal answer. At most 5.

Memory index (already remembered):
${memoryIndex || '(empty)'}

Threads:
${transcripts.map((x, i) => `=== Thread ${i + 1} ===\n${x}`).join('\n\n')}

Reply with only JSON: {"lessons":[{"rule":"the rule in one plain sentence, imperative","why":"the correction it came from, a few words","thread":<thread number>}]}`;
}

export function parseLessons(text, count) {
  try {
    const json = JSON.parse(String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1));
    return (json.lessons || [])
      .filter((l) => l && typeof l.rule === 'string' && l.rule.trim() && Number.isInteger(l.thread) && l.thread >= 1 && l.thread <= count)
      .slice(0, 5)
      .map((l) => ({ rule: l.rule.trim(), why: String(l.why || '').trim(), thread: l.thread }));
  } catch {
    return [];
  }
}

// Lessons are saved on their own now: this prompt is what a "save all" reply used to trigger.
export function savePrompt(lessons, memoryDir) {
  return `Save these lessons as Claude Code memories in ${memoryDir}. For each one: skip it if the memory index (MEMORY.md) already covers it; otherwise write one feedback memory file (feedback_<slug>.md) with frontmatter (name, description, metadata.type: feedback), the rule, a **Why:** line (the correction it came from) and a **How to apply:** line, then add one index line to MEMORY.md under "Rules (how to work)". Reply with one short line per lesson: saved, or skipped as already covered.

${lessons.map((l, i) => `${i + 1}. ${l.rule}${l.why ? ` (from: ${l.why})` : ''}`).join('\n')}`;
}

export function formatLessons(lessons, links, saved = false) {
  const lines = lessons.map((l, i) => {
    const link = links[l.thread - 1];
    return `${i + 1}. *${l.rule}*${l.why ? `\n    from: ${l.why}` : ''}${link ? ` · <${link}|thread>` : ''}`;
  });
  const intro = saved ? "i saved these for next time. reply `forget 2` if one is wrong:" : "reply `save 1 3` or `save all` here and i'll remember them for next time, or ignore this to skip:";
  return `${LESSONS_HEADER}. ${intro}\n\n${lines.join('\n')}`;
}

// Reads the day's threads, asks Claude for lessons and returns { text, lessons } (text null when none).
// `post` is false for dry runs. Never throws.
export async function reviewLessons({ client, config, state, botUserId, since, log = () => {}, post = true }) {
  try {
    const transcripts = [];
    const links = [];
    for (const t of threadsToReview(state.threads, { since })) {
      let messages = [];
      try {
        messages = (await client.conversations.replies({ channel: t.channel, ts: t.threadTs, limit: 200 })).messages || [];
      } catch {
        continue;
      }
      // Cleaned-up threads keep their deleted messages in an archive (src/cleanup.js).
      if (t.archive) {
        const live = new Set(messages.map((m) => m.ts));
        messages = [...readArchive(t.archive).filter((m) => !live.has(m.ts)), ...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
      }
      if (ownerAsks(messages, { ownerId: config.ownerId, botUserId, channel: t.channel, since }).length < 2) continue;
      // Our own lessons posts aren't material for more lessons.
      if (messages.some((m) => m.user === botUserId && (m.text || '').toLowerCase().startsWith(LESSONS_HEADER))) continue;
      transcripts.push(renderContext(messages, { botUserId, ownerId: config.ownerId, ownerName: config.ownerName }, 12_000));
      links.push(t.permalink || null);
      if (transcripts.length >= 25) break;
    }
    if (!transcripts.length) return { text: null, lessons: [] };
    let memoryIndex = '';
    try {
      memoryIndex = fs.readFileSync(memoryIndexPath(config.workdir), 'utf8').slice(0, 40_000);
    } catch {}
    const answer = await askClaude({ bin: config.claudeBin, prompt: lessonsPrompt(transcripts, memoryIndex, config.ownerName), model: 'sonnet', timeoutMs: 180_000 });
    const lessons = parseLessons(answer, transcripts.length);
    log(`[lessons] ${transcripts.length} threads reviewed, ${lessons.length} lessons`);
    if (!lessons.length) return { text: null, lessons };
    // Posting for real also saves: the owner asked for lessons to auto save. Dry runs never write memory.
    let saved = false;
    if (post && config.lessonsAutoSave) {
      const dir = path.dirname(memoryIndexPath(config.workdir));
      const run = await runClaude({ bin: config.claudeBin, cwd: config.workdir, timeoutMin: 5, model: 'sonnet', permissionMode: 'bypassPermissions', prompt: savePrompt(lessons, dir), sessionId: crypto.randomUUID(), env: RUN_ENV, disallowedTools: SELF_PROTECT }).promise;
      saved = run.ok;
      log(`[lessons] auto-save ${saved ? 'done' : 'failed'}`);
    }
    const text = formatLessons(lessons, links, saved);
    if (post) {
      await client.chat.postMessage({ channel: await ownerDm(client, config.ownerId), text, unfurl_links: false });
    }
    return { text, lessons };
  } catch (err) {
    log(`[lessons] failed: ${err.data?.error || err.message}`);
    return { text: null, lessons: [] };
  }
}

// The owner's existing DM with the bot (needs only im:read); opening one needs im:write.
async function ownerDm(client, ownerId) {
  let cursor;
  do {
    const res = await client.users.conversations({ types: 'im', limit: 200, cursor });
    const dm = (res.channels || []).find((c) => c.user === ownerId);
    if (dm) return dm.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return (await client.conversations.open({ users: ownerId })).channel.id;
}

// Once a day, after `hour` local time. A Mac that slept through it catches up when it wakes.
export function lessonsDue(lastDate, hour, now = new Date()) {
  const today = now.toLocaleDateString('en-CA');
  return now.getHours() >= hour && lastDate !== today ? today : null;
}
