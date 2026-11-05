// Clean up: once a conversation with the bot is over, the bot's first message in it (its "on it" status
// line) is edited into a summary ("<owner> asked me to …, here's the result") and the asks and other
// replies are deleted, so a thread someone checks later reads in seconds. Nothing new is ever posted:
// an edit doesn't notify anyone.
//
// - Automatic CLEANUP_AFTER_MIN after a thread's last activity (only when the last run went OK);
//   "clean up" in the thread does it now. Needs SLACK_USER_TOKEN (the owner's xoxp with the chat:write
//   user scope): a bot token can only delete the bot's own messages, so without it nothing is cleaned.
// - Deletes only what this feature knows it owns: the owner's tracked asks (t.askTs) and the bot's own
//   messages since the first of them. Never messages with files (renders, uploads are the output),
//   never other people's messages, guest threads, add-on threads or threads started by a bot post.
// - The owner's root ask goes too (Slack keeps a "This message was deleted" stub over the summary).
//   The thread key and its Claude session stay, so a reply in the thread carries on.
// - Resumable: the plan and progress are saved in t.cleanup, so a restart mid-way finishes the job.
// - The transcript is archived to data/cleaned/ first: the daily lessons DM still reads it.
import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './claude.js';
import { renderContext, messageText } from './context.js';

export const CLEANUP_COMMAND = /^clean ?up[.!]*$/i;

// Ready to clean (or to finish a cleanup that was cut off).
export function cleanupDue(t, { now = Date.now(), afterMin, running = false }) {
  if (running || t.guest || !t.askTs?.length) return false;
  if (t.pending?.length || t.inflight || t.finalPending) return false;
  if (t.cleanup || t.cleanupNow) return true;
  return afterMin != null && t.lastOk === true && now - (t.lastActivity || 0) >= afterMin * 60_000;
}

const ownBy = (m, botUserId) => m.user === botUserId || (botUserId && m.bot_profile?.user_id === botUserId);

// Which bot message becomes the summary and what gets deleted. `messages` is the whole thread, root first.
// The summary is the earlier summary of this thread if there is one, else the bot's first message since
// the first ask. Returns null when the thread isn't ours to clean (started by a bot post) or has no bot
// message to edit.
export function planCleanup(messages, { askTs, botUserId, threadTs, summaryTs }) {
  const asks = new Set(askTs);
  const root = messages.find((m) => m.ts === threadTs);
  if (!root || ownBy(root, botUserId)) return null;
  const from = Math.min(...askTs.map(Number));
  const ours = (m) => ownBy(m, botUserId) && !m.files?.length;
  const keep = messages.find((m) => m.ts === summaryTs && ours(m)) || messages.find((m) => m.ts !== threadTs && ours(m) && Number(m.ts) >= from);
  if (!keep) return null;
  const gone = messages.filter((m) => m !== keep && !m.files?.length && (asks.has(m.ts) || (ours(m) && Number(m.ts) >= from)));
  // Replies first, the root last.
  gone.sort((a, b) => (a.ts === threadTs) - (b.ts === threadTs) || Number(a.ts) - Number(b.ts));
  const transcript = [...new Set([root, keep, ...gone])].sort((a, b) => Number(a.ts) - Number(b.ts));
  return { edit: keep.ts, delete: gone.map((m) => ({ ts: m.ts, owner: !ownBy(m, botUserId) })), transcript };
}

export function summaryPrompt(transcript, { ownerName, botName }) {
  return `Below is a finished Slack conversation between ${ownerName} and you (${botName}, their AI assistant). It is about to be deleted and replaced by one message from you (your first reply, edited), so anyone who opens it later sees what happened at a glance.

Write that message. Start with what ${ownerName} asked, in one line ("${ownerName} asked me to …"). Then the result: what you did and the final output, as short as it can be without losing anything someone would come back for. Keep every link, file name and number exactly as written. Write people as plain names ("Alex"), never <@…> tags: this message must not ping anyone again. Leave out status lines, back-and-forth and dead ends unless they changed the result. If ${ownerName} asked for several things, cover each one. Slack formatting (*bold*, bullets), no headings, no em dashes. Reply with only the message.

Conversation:
${transcript}`;
}

// Used when the model doesn't answer: the first ask and the last reply, word for word.
export function fallbackSummary(transcript, { askTs, botUserId, ownerName }) {
  const ask = transcript.find((m) => askTs.includes(m.ts));
  const reply = [...transcript].reverse().find((m) => ownBy(m, botUserId) && !/^(yes, i'm on it|done ✅|finished, needs a look)/i.test(m.text || ''));
  const askText = messageText(ask || {}).replace(/<@\w+>\s*/, '').trim();
  return [`${ownerName} asked: ${askText || '(see above)'}`, messageText(reply || {}).replace(/^<@\w+>\s*/, '')].filter(Boolean).join('\n\n');
}

// Messages archived by earlier cleanups of this thread (for the lessons DM).
export function readArchive(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// The whole thread, every page: a partial list could make the root look safe to delete.
async function allReplies(client, channel, ts) {
  const out = [];
  let cursor;
  do {
    const res = await client.conversations.replies({ channel, ts, limit: 200, cursor });
    out.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return out;
}

// <@U…> → @Name, so the summary never pings people a second time.
async function unping(client, text) {
  const ids = [...new Set([...text.matchAll(/<@(\w+)(\|[^>]*)?>/g)].map((m) => m[1]))];
  const names = {};
  for (const id of ids) {
    try {
      const { user } = await client.users.info({ user: id });
      names[id] = user.profile?.display_name || user.real_name || user.name;
    } catch {}
  }
  return text.replace(/<@(\w+)(\|([^>]*))?>/g, (all, id, _, label) => `@${names[id] || label || 'someone'}`);
}

// Errors that mean the user token can't delete the owner's messages at all: retrying won't help.
const TOKEN_BROKEN = /invalid_auth|not_authed|token_revoked|token_expired|account_inactive|missing_scope|cant_delete_message/;

// Runs (or resumes) one thread's cleanup. `dryRun` returns the plan and summary without changing anything.
// Returns { done, plan, summary } and never throws on Slack errors for single messages.
// `busy()` says a new ask came in meanwhile: then nothing is edited or deleted (it's checked before the first change).
// Automatic cleanups also wait until nobody (teammates, untagged chat included) has posted in the thread for CLEANUP_AFTER_MIN.
export async function runCleanup({ client, config, t, botUserId, save = () => {}, log = () => {}, dryRun = false, busy = () => false, now = Date.now() }) {
  if (!t.cleanup) {
    const messages = await allReplies(client, t.channel, t.threadTs);
    const newest = Math.max(0, ...messages.map((m) => Number(m.ts) * 1000));
    if (!dryRun && !t.cleanupNow && config.cleanupAfterMin != null && now - newest < config.cleanupAfterMin * 60_000) return { done: false, plan: null };
    const plan = planCleanup(messages, { askTs: t.askTs, botUserId, threadTs: t.threadTs, summaryTs: t.summaryTs });
    if (!plan || !plan.delete.length) {
      if (!dryRun) {
        Object.assign(t, { askTs: [], cleanupNow: false });
        save();
      }
      return { done: false, plan };
    }
    const opts = { botUserId, ownerId: config.ownerId, ownerName: config.ownerName };
    const text = renderContext(plan.transcript, opts, 30_000);
    const answer = await askClaude({ bin: config.claudeBin, prompt: summaryPrompt(text, { ownerName: config.ownerName, botName: config.botName }), model: 'sonnet', timeoutMs: 120_000 });
    const summary = await unping(client, answer?.trim() || fallbackSummary(plan.transcript, { askTs: t.askTs, botUserId, ownerName: config.ownerName }));
    if (dryRun) return { done: false, plan, summary };
    if (busy()) {
      // A new ask came in: the conversation isn't over. It is looked at again once that one finishes.
      t.cleanupNow = false;
      save();
      return { done: false, plan, summary };
    }
    const dir = path.join(config.dataDir, 'cleaned');
    fs.mkdirSync(dir, { recursive: true });
    t.archive ??= path.join(dir, `${t.sessionId}.json`);
    fs.writeFileSync(t.archive, JSON.stringify([...readArchive(t.archive), ...plan.transcript]));
    t.cleanup = { plan, summary, done: [] };
    save();
  }
  const c = t.cleanup;
  if (!c.edited) {
    // Editing is safe to repeat, so a restart right after it just edits again.
    await client.chat.update({ channel: t.channel, ts: c.plan.edit, text: c.summary });
    c.edited = true;
    t.summaryTs = c.plan.edit;
    save();
  }
  for (const d of c.plan.delete) {
    if (c.done.includes(d.ts)) continue;
    try {
      await client.chat.delete({ channel: t.channel, ts: d.ts, ...(d.owner ? { token: config.userToken } : {}) });
    } catch (err) {
      const why = err.data?.error || err.message;
      if (/ratelimited/.test(why)) return { done: false, plan: c.plan };
      if (d.owner && TOKEN_BROKEN.test(why)) {
        // Nothing more is deleted; the thread resumes from here once the token is fixed and the bot restarts.
        log(`[cleanup] the user token can't delete ${config.ownerName}'s messages (${why}): Clean Up is off until SLACK_USER_TOKEN is fixed`);
        config.userToken = '';
        return { done: false, plan: c.plan };
      }
      if (why !== 'message_not_found') log(`[cleanup] ${t.channel}:${t.threadTs} could not delete ${d.ts}: ${why}`);
    }
    c.done.push(d.ts);
    save();
  }
  const deleted = c.done.length;
  // Asks that came in after the plan was made stay tracked for the next cleanup.
  const cleaned = new Set(c.plan.delete.map((d) => d.ts));
  Object.assign(t, { askTs: t.askTs.filter((ts) => !cleaned.has(ts) && !c.plan.transcript.some((m) => m.ts === ts)), cleanupNow: false, cleanup: null });
  save();
  log(`[cleanup] ${t.channel}:${t.threadTs} folded ${deleted} messages into one`);
  return { done: true, plan: c.plan, summary: c.summary };
}
