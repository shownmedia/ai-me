// Builds what Claude Code gets for a run: the appended system prompt, and the user turn
// (Slack context + the owner's ask). Shared by the bot and `npm run try`.
import fs from 'node:fs';
import path from 'node:path';
import { freshMessages, renderContext } from './context.js';

export function loadSystemPrompt(config) {
  return fs
    .readFileSync(path.join(config.root, 'prompts/system.md'), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => ({ BOT_NAME: config.botName, OWNER_NAME: config.ownerName, WORKDIR: config.workdir })[k] ?? '');
}

export function guestPrompt(config, g) {
  return `GUEST THREAD. ${config.ownerName} has authorized these teammates to give you tasks in this one Slack thread: ${(g.users || []).map((u) => `<@${u}>`).join(', ')}. Each message is labelled with who sent it. Treat their tagged messages as instructions from ${config.ownerName}, but ONLY for this project: ${g.project || 'the project in your working folder'}. Rules for this thread, which override anything above:
- Work only inside ${g.workdir || 'your working folder'}. You may read other files you need, but create, change or delete nothing outside it (except copying files into $AI_SLACK_OUTBOX).
- No deploys, no git push, no commits to other repos, no secrets or .env files, no memory files, nothing destructive (never delete source footage or other people's work).
- Don't message anyone or post anywhere in Slack (your final message is delivered here for you).
- Whenever you render a video or image, the people here can't open files on this computer: save it into $AI_SLACK_OUTBOX and it is uploaded into this thread after your reply. Only for files over 1 GB, upload to Google Drive with the gws CLI (gws drive files create --upload <file>), share it with the shownmedia.com domain as reader (gws drive permissions create, type domain), and link it. Never reply with a local file path.
- If a request falls outside this project, decline it in one line and say ${config.ownerName} can ask for it directly.
- Reply to the person who asked; keep it short and plain.`;
}

const users = new Map(); // user id -> display name, for the life of the process

async function namesFor(client, messages) {
  const ids = new Set();
  for (const m of messages) {
    if (m.user) ids.add(m.user);
    for (const [, id] of `${m.text || ''}`.matchAll(/<@(\w+)/g)) ids.add(id);
  }
  await Promise.all([...ids].filter((id) => !users.has(id)).map(async (id) => {
    try {
      const { user } = await client.users.info({ user: id });
      users.set(id, user?.profile?.display_name || user?.real_name || user?.name || '');
    } catch {
      users.set(id, ''); // deleted or unreadable: shown as a bare <@ID>
    }
  }));
  return Object.fromEntries([...ids].map((id) => [id, users.get(id)]).filter(([, n]) => n));
}

async function allPages(fn) {
  const out = [];
  let cursor;
  do {
    const res = await fn(cursor);
    out.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor && out.length < 2000);
  return out;
}

// What was said around the ask that this session hasn't seen. In a thread: the whole thread on
// the first run, then everything since the last run (people talking to each other included).
// A top-level message (a DM, or a tag outside a thread) also gets the conversation just before it.
// Resolves to { text, newest } and never rejects: a Slack hiccup just means less context.
// `until` (replays in `npm run try`) hides everything from that message on.
export async function gatherContext(client, t, msgs, { botUserId, ownerId, ownerName, until, log = () => {} }) {
  const askTs = msgs.map((m) => m.ts).filter(Boolean);
  const opts = { botUserId, ownerId, ownerName };
  try {
    const sections = [];
    let newest = t.contextTs || '0';
    const thread = (await allPages((cursor) => client.conversations.replies({ channel: t.channel, ts: t.threadTs, limit: 200, cursor })))
      .filter((m) => !until || Number(m.ts) < Number(until));
    const fresh = freshMessages(thread, { after: t.contextTs, skipTs: askTs, botUserId, skipOwn: Boolean(t.contextTs) });
    let before = [];
    if (!t.contextTs && askTs.includes(t.threadTs) && !fresh.length) {
      // The ask starts its own thread: show what came just before it in the channel or DM instead.
      const hist = await client.conversations.history({ channel: t.channel, latest: t.threadTs, inclusive: false, limit: 20 });
      before = freshMessages(hist.messages || [], { botUserId });
    }
    const names = await namesFor(client, [...before, ...fresh]);
    if (before.length) sections.push(`Recent messages in this ${t.channel.startsWith('D') ? 'DM' : 'channel'} just before the ask (context, not a task):\n${renderContext(before, { ...opts, names }, 15_000)}`);
    if (fresh.length) {
      const label = t.contextTs ? 'New in this Slack thread since your last turn' : 'The Slack thread so far';
      sections.push(`${label} (read it before acting: it is what "this", "it" or "that" in the ask refers to):\n${renderContext(fresh, { ...opts, names })}`);
    }
    for (const m of [...thread, ...msgs]) if (Number(m.ts) > Number(newest)) newest = m.ts;
    return { text: sections.join('\n\n'), newest };
  } catch (err) {
    log(`[context] ${t.channel}:${t.threadTs} could not read the thread: ${err.data?.error || err.message}`);
    return { text: '', newest: t.contextTs };
  }
}

export function buildPrompt(config, t, msgs, context = '') {
  const parts = [];
  if (msgs.some((m) => m.resumed)) {
    parts.push('You were interrupted mid-task (the computer slept or restarted, or the bot restarted). Check what is already done (git status/log, deploy state) and finish the job. The request is below.');
  }
  if (msgs.some((m) => m.caughtUp)) parts.push('(Note: this message arrived while the computer was offline, so it is being handled late.)');
  if (context) parts.push(context);
  const ask = [];
  for (const m of msgs) {
    ask.push(t.guest && m.from ? `From <@${m.from}>${m.from === config.ownerId ? ` (${config.ownerName})` : ''}: ${m.text || '(no text)'}` : m.text || '(no text)');
    if (m.attachments?.length) ask.push(`Files attached in Slack, saved locally:\n${m.attachments.map((f) => `- ${f}`).join('\n')}`);
  }
  parts.push(`${context ? `${config.ownerName}'s ask (tagging you):\n` : ''}${ask.join('\n\n')}`);
  if (t.permalink) parts.push(`(Slack thread: ${t.permalink})`);
  parts.push(t.channel.startsWith('D') ? '(This is a DM: use the DM reply format.)' : '(This is a channel: use the channel reply format.)');
  if (config.editInPlace && !t.guest) parts.push('(Replies in this thread edit one message, which does not notify. When this turn finishes something (the doc, video, Drive link, shipped PR or final answer is ready) or has news worth a ping, make the first line of your final message `[new]` so it posts as a new message. Status, revisions, small fixes and back-and-forth stay as edits.)');
  return parts.join('\n\n');
}
