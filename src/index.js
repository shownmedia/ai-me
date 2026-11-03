// Slack -> local Claude Code -> Slack.
//
// The one promise this bot makes: every request from the owner gets exactly one
// final reply in its thread. That holds across crashes, restarts, timeouts and
// the computer sleeping, because:
//   - work is persisted before it runs (pending -> inflight -> finalPending)
//   - interrupted work is re-queued on startup and resumed in the same Claude session
//   - final replies that fail to post are retried until they land
//   - messages sent while the bot was offline are found by a periodic catch-up scan
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bolt from '@slack/bolt';
import { config } from './config.js';
import { createStore } from './store.js';
import { runClaude, estimateTask, activeRuns, SELF_PROTECT, RUN_ENV } from './claude.js';
import { reviewLessons, lessonsDue } from './lessons.js';
import { outboxDir, prepareOutbox, collectOutbox, clearOutbox } from './outbox.js';
import { toMrkdwn, chunk, lowercase, parseComms, commsReply, threadsWithNewReplies, guestFor, guestThread } from './format.js';
import { loadSystemPrompt, guestPrompt, buildPrompt, gatherContext } from './prompt.js';
import { loadAddons } from './extensions.js';
import { updateDue, selfUpdate } from './update.js';

const { App, LogLevel } = bolt;
const store = createStore(path.join(config.dataDir, 'state.json'));
const { state } = store;
const systemPrompt = loadSystemPrompt(config);
const addons = await loadAddons(config); // launch recaps + game tape, when src/addons.js is present

const app = new App({ token: config.botToken, appToken: config.appToken, socketMode: true, logLevel: LogLevel.WARN });
const client = app.client;
// Every message the bot writes goes through voice(), so a style setting (LOWERCASE) applies everywhere.
const voice = (text) => (config.lowercase ? lowercase(text) : text);
for (const method of ['postMessage', 'update', 'postEphemeral']) {
  const original = client.chat[method].bind(client.chat);
  client.chat[method] = (args) => original({ ...args, text: voice(args.text) });
}
let botUserId = '';
let teamId = '';
const lastDecline = new Map(); // user:channel -> time, so a spammer can't make the bot spam back
const running = new Map(); // thread key -> { stop } for every job in progress
let lessonsBusy = false; // the daily lessons DM is being written (it reads Slack before its Claude run starts)

const keyOf = (channel, threadTs) => `${channel}:${threadTs}`;
const humanMinutes = (n) => {
  if (n < 60) return `${n} min`;
  const h = Math.round(n / 30) / 2;
  return `${h} hour${h === 1 ? '' : 's'}`;
};
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function safe(fn, label) {
  try {
    return await fn();
  } catch (err) {
    const code = err.data?.error || err.message;
    if (!['already_reacted', 'no_reaction', 'message_not_found'].includes(code)) log(`[slack] ${label} failed: ${code}`);
    return null;
  }
}

function getThread(channel, threadTs) {
  const k = keyOf(channel, threadTs);
  state.threads[k] ??= {
    channel,
    threadTs,
    sessionId: crypto.randomUUID(),
    started: false,
    model: config.defaultModel,
    pending: [],
    inflight: null,
    finalPending: null,
    lastActivity: Date.now(),
  };
  return state.threads[k];
}

async function downloadFiles(files, ts) {
  if (!files?.length) return [];
  const dir = path.join(config.dataDir, 'files', ts.replace('.', '-'));
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const f of files) {
    if (!f.url_private_download) continue;
    try {
      const res = await fetch(f.url_private_download, { headers: { Authorization: `Bearer ${config.botToken}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = path.join(dir, (f.name || f.id).replace(/[^\w.-]+/g, '_'));
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      out.push(file);
    } catch (err) {
      log(`[files] could not download ${f.name}: ${err.message}`);
    }
  }
  return out;
}

// ---- intake -----------------------------------------------------------------

// What counts as talking to the bot: anything in a DM, or a message that tags it. In channels
// the owner also talks to people in the same threads, so untagged replies are never tasks.
function addressedToBot({ channel, text = '' }) {
  if (channel.startsWith('D')) return true;
  return Boolean(botUserId && text.includes(`<@${botUserId}>`));
}

// Guest threads: the owner can let named teammates task the bot in one specific thread, scoped to one
// project folder. Listed in guests.json at the repo root (re-read on every message, so no restart):
// [{ "channel": "C…", "thread_ts": "123.456", "users": ["U…"], "workdir": "~/project", "project": "what they may work on" }]
function loadGuests() {
  try {
    return JSON.parse(fs.readFileSync(config.guestsFile, 'utf8'));
  } catch {
    return [];
  }
}

async function incoming({ channel, ts, threadTs, user, text = '', files, caughtUp = false, defer = false }) {
  if (store.seen(ts)) return;
  store.markSeen(ts);
  // Add-on threads (recaps, game tape review) have their own rules for who may ask.
  const guest = addons.scope(channel, user, threadTs) || (user !== config.ownerId && threadTs ? guestFor(loadGuests(), channel, threadTs, user) : null);
  if (user !== config.ownerId && !guest) {
    store.save();
    // Someone else asked for something: tell only them, quietly, and mark the message.
    const addressed = channel.startsWith('D') || (botUserId && text.includes(`<@${botUserId}>`));
    const throttleKey = `${user}:${channel}`;
    if (addressed && user && Date.now() - (lastDecline.get(throttleKey) || 0) > 10 * 60_000) {
      lastDecline.set(throttleKey, Date.now());
      log(`[intake] declined ${user} in ${channel}`);
      await safe(() => client.chat.postEphemeral({ channel, user, thread_ts: threadTs, text: `Sorry, only ${config.ownerName} can give me tasks. Ask ${config.ownerName} if you need this done.` }), 'ephemeral');
      await safe(() => client.reactions.add({ channel, timestamp: ts, name: config.denyEmoji }), 'react');
    }
    return;
  }
  const k = keyOf(channel, threadTs || ts);
  // Our own Claude run may post through the owner's Slack connector. Anything with the connector
  // footer that was written while a job was running in this thread is an echo, not a new ask
  // (judged by the message's own timestamp, so late arrivals after a restart are caught too).
  const ran = state.threads[k]?.lastRun;
  const sentAt = Number(ts) * 1000;
  const duringRun = running.has(k) || (ran && sentAt >= ran.start && sentAt <= (ran.end || Infinity) + 10_000);
  const isStop = /^\s*(stop|cancel)\b/i.test(text.replace(/\s*\*Sent using\*.*$/s, ''));
  if (duringRun && !isStop && /\*Sent using\* <@\w+/.test(text)) {
    log(`[intake] ignored a connector post in the running thread ${k}`);
    store.save();
    return;
  }
  const t = getThread(channel, threadTs || ts);
  t.lastActivity = Date.now();
  t.lastAsker = user;
  // A guest thread stays scoped to its project for everyone who asks in it, the owner included.
  const scope = guest || guestThread(loadGuests(), channel, threadTs || ts);
  if (scope) t.guest = { workdir: scope.workdir, project: scope.project, users: scope.users };
  if (scope?.thread) Object.assign(t, scope.thread);
  if (scope?.opus && !t.modelPinned) t.model = config.opusModel;
  // Never sweep up older thread messages from before we were asked.
  if (Number(ts) > Number(t.lastReplySeen || 0)) t.lastReplySeen = ts;
  // Drop our own mention and the "Sent using @Claude" footer Slack adds to messages sent via its connector.
  const clean = text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').replace(/\s*\*Sent using\* <@\w+(\|[^>]*)?>\s*$/, '').trim();

  if (/^(stop|cancel)[.!]*$/i.test(clean)) {
    t.pending = [];
    store.save();
    if (running.has(k)) running.get(k).stop();
    else await safe(() => client.chat.postMessage({ channel, thread_ts: t.threadTs, text: 'Nothing is running in this thread.' }), 'post');
    return;
  }
  // Only an explicit ask switches models ("use opus", "opus: …"), not any mention of the word.
  // Either one pins the thread's model, so automatic routing leaves it alone.
  if (/(^|\b(use|switch to|with|on|in)\s+)opus\b/i.test(clean)) Object.assign(t, { model: config.opusModel, modelPinned: true });
  else if (/(^|\b(use|switch to|with|on|in)\s+)sonnet\b/i.test(clean)) Object.assign(t, { model: config.defaultModel, modelPinned: true });

  const attachments = await downloadFiles(files, ts);
  t.pending.push({ ts, text: clean, attachments, caughtUp, queuedAt: Date.now(), askedAt: Date.now(), from: user });
  store.save();
  log(`[intake] ${k}${caughtUp ? ' (caught up)' : ''}: ${clean.slice(0, 80)}`);
  // Reactions only ever go on the message that started the task, never on every follow-up.
  t.reactTs ??= ts;
  const firstAsk = ts === t.reactTs;
  if (firstAsk) await safe(() => client.reactions.add({ channel, timestamp: ts, name: config.workingEmoji }), 'react');

  // Queued behind other work: a quiet hourglass instead of a message.
  if (firstAsk && (running.has(k) || running.size >= config.maxParallel)) await safe(() => client.reactions.add({ channel, timestamp: ts, name: 'hourglass_flowing_sand' }), 'react');
  if (!defer) pump(); // the recap watch queues a whole batch first, then pumps once
}

const isJoin = (text = '') => /^\s*(<@\w+(\|[^>]*)?>\s*)?!join\b/i.test(text);
const isCommand = (text = '') => Boolean(parseComms(text, botUserId)) || isJoin(text);

// Slack sends a tagged message twice (app_mention + message): answer each command once.
const answered = new Set();
function firstTime(ts) {
  if (answered.has(ts)) return false;
  answered.add(ts);
  if (answered.size > 500) answered.delete(answered.values().next().value);
  return true;
}

// A static, no-Claude reply anyone can trigger: instant, no cost, no owner gate.
function handleComms(ev) {
  if (!config.comms.enabled) return false;
  const cmd = parseComms(ev.text, botUserId);
  if (!cmd) return false;
  if (!firstTime(ev.ts)) return true;
  const text = commsReply({ ...cmd, channel: ev.channel, channelType: ev.channel_type }, config.comms);
  safe(() => client.chat.postMessage({ channel: ev.channel, thread_ts: ev.thread_ts || ev.ts, text, unfurl_links: false }), 'comms');
  return true;
}

// Slack has no API to add a bot to a group DM that already exists (conversations.invite only
// works on channels), so the closest thing to "join my group chat" is opening a fresh
// conversation with the same people plus the bot. If that exact group (same members, bot
// included) already exists, Slack resumes it instead of making a duplicate.
async function joinGroup(ev) {
  const reply = (text) => safe(() => client.chat.postMessage({ channel: ev.channel, thread_ts: ev.thread_ts || ev.ts, text }), 'join-reply');
  const users = [...new Set((ev.text.match(/<@(\w+)>/g) || []).map((m) => m.slice(2, -1)))];
  if (!users.length) {
    await reply('Tag who you want in the chat with me, e.g. `!join @andy @alejandro`.');
    return;
  }
  const opened = await safe(() => client.conversations.open({ users: [config.ownerId, ...users].join(',') }), 'join-open');
  if (!opened?.channel?.id) {
    await reply("Couldn't open that chat, check the names and try again.");
    return;
  }
  await safe(() => client.chat.postMessage({ channel: opened.channel.id, text: 'hey, added myself here so i can help in this chat too.' }), 'join-hello');
  await reply(`Done, I'm in <#${opened.channel.id}>. Slack can't add me to a group chat that already exists, so this is a new conversation with the same people; earlier messages there won't be visible to me.`);
}

function handleJoinGroup(ev) {
  if (ev.user !== config.ownerId || !isJoin(ev.text)) return false;
  if (!firstTime(ev.ts)) return true;
  joinGroup(ev).catch((err) => log('[join] failed:', err.message));
  return true;
}

function route(ev) {
  if (!ev || ev.bot_id || (ev.subtype && ev.subtype !== 'file_share')) return;
  if (ev.user_team && teamId && ev.user_team !== teamId) return; // people from other orgs (Slack Connect) never reach the bot
  if (handleComms(ev)) return;
  if (handleJoinGroup(ev)) return;
  if (addons.intercept?.(ev)) return; // an add-on answered it without a Claude run (a sweeper "no")
  addons.observe(ev); // add-ons that act on channel chatter (src/assist.js); never tasks
  const busyHere = running.has(keyOf(ev.channel, ev.thread_ts)) && /^\s*(stop|cancel)\b/i.test(ev.text || '');
  if (!busyHere && !addressedToBot({ channel: ev.channel, threadTs: ev.thread_ts, text: ev.text })) return;
  incoming({ channel: ev.channel, ts: ev.ts, threadTs: ev.thread_ts, user: ev.user, text: ev.text, files: ev.files }).catch((err) =>
    log('[intake] failed:', err.message),
  );
}

app.event('app_mention', async ({ event }) => route(event));
app.message(async ({ message }) => route(message));

// ---- worker -----------------------------------------------------------------

async function runJob(k, t) {
  const msgs = t.pending.splice(0);
  t.inflight = msgs;
  t.lastRun = { start: Date.now() - 5_000, end: null };
  store.save();

  // Restarts are invisible to the owner: a resumed job just carries on under the same status line.
  const opening = msgs.some((m) => m.caughtUp && !m.resumed) ? 'Sorry for the wait, I was offline. On it now.' : "Yes, I'm on it.";
  if (t.reactTs) safe(() => client.reactions.remove({ channel: t.channel, timestamp: t.reactTs, name: 'hourglass_flowing_sand' }), 'unreact');
  const status = t.statusTs
    ? { ts: t.statusTs } // an interrupted run already has a status line: reuse it
    : await safe(() => client.chat.postMessage({ channel: t.channel, thread_ts: t.threadTs, text: opening }), 'post');
  t.statusTs = status?.ts || null;
  store.save();
  // After the acknowledgement, so the owner sees "on it" as fast as possible.
  if (!t.started && !t.permalink) {
    const p = await safe(() => client.chat.getPermalink({ channel: t.channel, message_ts: t.threadTs }), 'permalink');
    if (p?.permalink) t.permalink = p.permalink;
  }

  // Plain-English status with a rough time estimate, never tool names or code.
  const startedAt = Date.now();
  let lastStep = '';
  let etaMin = null;
  let shown = '';
  const showStatus = () => {
    if (!status?.ts || etaMin == null) return;
    const left = Math.ceil(etaMin - (Date.now() - startedAt) / 60_000);
    const first = Date.now() - startedAt < 90_000;
    const text = left <= 0 ? `${opening} Taking a bit longer than I thought, still going.` : `${opening} ${first ? 'Should take about' : 'About'} ${humanMinutes(left)}${first ? '.' : ' left.'}`;
    if (text === shown) return;
    shown = text;
    safe(() => client.chat.update({ channel: t.channel, ts: status.ts, text }), 'update');
  };
  const estimate = estimateTask({ bin: config.claudeBin, task: msgs.map((m) => m.text).join('\n') });
  estimate.then((e) => {
    etaMin = e.minutes;
    showStatus();
  });
  // A thread's first run picks its model from the same guess: Opus for real work, Sonnet for quick asks.
  // Waits a few seconds at most (after the "on it" post, so the ack stays instant); later runs keep it.
  if (config.autoModel && !t.started && !t.modelPinned) {
    const e = await Promise.race([estimate, new Promise((r) => setTimeout(() => r(null), 8_000))]);
    if (e?.model) {
      t.model = e.model === 'opus' ? config.opusModel : config.defaultModel;
      store.save();
    }
    log(`[route] ${k} -> ${t.model}${e?.model ? '' : ' (no guess in time, default)'}`);
  }
  const statusTimer = setInterval(showStatus, 60_000);
  const onProgress = (step) => {
    lastStep = step;
  };

  // What was said in the thread (or just before the ask) that this session hasn't seen yet.
  // Files for the thread (renders, images, screenshots) go here and are uploaded after the reply.
  const outbox = outboxDir(config.dataDir, t.channel, t.threadTs);
  prepareOutbox(outbox, { resumed: msgs.some((m) => m.resumed) });

  const context = await gatherContext(client, t, msgs, { botUserId, ownerId: config.ownerId, ownerName: config.ownerName, log });
  const prompt = buildPrompt(config, t, msgs, context.text);

  const attempt = (resume) => {
    const run = runClaude({
      bin: config.claudeBin,
      cwd: t.guest?.workdir ? t.guest.workdir.replace(/^~/, process.env.HOME || '') : config.workdir,
      prompt,
      sessionId: t.sessionId,
      resume,
      model: t.model,
      permissionMode: config.permissionMode,
      systemPrompt: [systemPrompt, addons.systemPrompt(t) || (t.guest ? guestPrompt(config, t.guest) : '')].filter(Boolean).join('\n\n'),
      maxBudgetUsd: config.maxBudgetUsd,
      chrome: config.chrome,
      extraArgs: config.claudeExtraArgs,
      disallowedTools: SELF_PROTECT,
      timeoutMin: config.timeoutMin,
      onProgress,
      onSessionStart: () => {
        if (!t.started) {
          t.started = true;
          store.save();
        }
      },
      env: { ...RUN_ENV, AI_SLACK_OUTBOX: outbox },
    });
    running.get(k).stop = run.stop;
    return run.promise;
  };

  const firstResume = t.started;
  let res;
  try {
    res = await attempt(firstResume);
    if (!res.sessionStarted && !firstResume && /already in use/i.test(res.text)) {
      // The session was created before an interruption (older state files didn't record that): resume it.
      t.started = true;
      res = await attempt(true);
    }
    if (!res.sessionStarted && t.started && /no conversation found/i.test(res.text)) {
      // The saved session is gone (e.g. transcripts were cleaned up): start a fresh one.
      t.sessionId = crypto.randomUUID();
      t.started = false;
      res = await attempt(false);
    }
  } finally {
    clearInterval(statusTimer);
  }
  if (res.sessionStarted) {
    t.started = true;
    t.contextTs = context.newest; // the session has now seen everything up to here
  }

  // Time since the owner asked (survives restarts), not just this attempt.
  const askedAt = Math.min(startedAt, ...msgs.map((m) => m.askedAt || startedAt));
  const secs = Math.round((Date.now() - askedAt) / 1000);
  // No cost in Slack: on a Claude subscription the reported cost is only an API-price estimate, not a charge.
  const footer = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  let text = res.text;
  if (res.stopped) text = 'Stopped. Reply here if you want me to pick it back up.';
  else if (res.timedOut) text = `I ran out of time (${config.timeoutMin} min) before finishing. Last thing I was doing: ${lastStep || 'unknown'}. Reply \`continue\` and I'll keep going.\n\n${text}`;
  const { files, skipped } = collectOutbox(outbox);
  if (skipped.length) text += `\n\n_Couldn't attach: ${skipped.join('; ')}_`;
  if (res.denials?.length) text += `\n\n_Blocked by permissions: ${[...new Set(res.denials.map((d) => d.tool_name))].join(', ')}_`;

  t.finalPending = {
    text,
    ok: res.ok && !res.timedOut && !res.stopped,
    msgTs: [t.reactTs || msgs[0]?.ts].filter((ts) => /^\d+\.\d+$/.test(ts || '')),
    statusTs: status?.ts,
    footer,
    posted: 0,
    files,
    uploaded: 0,
    outbox,
  };
  t.inflight = null;
  t.statusTs = null;
  if (t.lastRun) t.lastRun.end = Date.now();
  t.lastActivity = Date.now();
  store.save();
  log(`[job] ${k} finished ok=${t.finalPending.ok} ${footer}${res.costUsd ? ` (api-equivalent $${res.costUsd.toFixed(2)})` : ''}`);
  await deliver(t);
}

// One delivery per thread at a time: the 60s retry, boot and a finishing job can all reach the same
// thread, and two at once would post or upload the same part twice.
const delivering = new Set();
async function deliver(t) {
  const k = keyOf(t.channel, t.threadTs);
  if (!t.finalPending || delivering.has(k)) return !t.finalPending;
  delivering.add(k);
  try {
    return await deliverOnce(t);
  } finally {
    delivering.delete(k);
  }
}

async function deliverOnce(t) {
  const f = t.finalPending;
  if (!f) return true;
  try {
    const parts = chunk(`<@${t.guest && t.lastAsker ? t.lastAsker : config.ownerId}> ${toMrkdwn(f.text)}`);
    for (let i = f.posted; i < parts.length; i++) {
      await client.chat.postMessage({ channel: t.channel, thread_ts: t.threadTs, text: parts[i], unfurl_links: false, unfurl_media: false });
      f.posted = i + 1;
      store.save();
    }
  } catch (err) {
    log(`[deliver] ${keyOf(t.channel, t.threadTs)} will retry: ${err.data?.error || err.message}`);
    return false;
  }
  if (!(await uploadFiles(t, f))) return false;
  if (f.statusTs) {
    await safe(() => client.chat.update({ channel: t.channel, ts: f.statusTs, text: f.ok ? `Done ✅ · ${f.footer}` : `Finished, needs a look ⚠️ · ${f.footer}` }), 'update');
  }
  for (const ts of f.msgTs) {
    await safe(() => client.reactions.remove({ channel: t.channel, timestamp: ts, name: config.workingEmoji }), 'unreact');
    await safe(() => client.reactions.add({ channel: t.channel, timestamp: ts, name: f.ok ? config.finishedEmoji : 'warning' }), 'react');
    if (f.ok && config.doneEmoji) await safe(() => client.reactions.add({ channel: t.channel, timestamp: ts, name: config.doneEmoji }), 'react');
  }
  if (f.outbox) clearOutbox(f.outbox);
  t.finalPending = null;
  t.reactTs = null; // the next task in this thread gets its own reactions
  store.save();
  return true;
}

// Uploads the run's files into the thread after the text, one at a time, resuming where a retry left off.
// A file that keeps failing is reported once in the thread and skipped; it never blocks or repeats the reply.
async function uploadFiles(t, f) {
  const files = f.files || [];
  while ((f.uploaded || 0) < files.length) {
    const file = files[f.uploaded || 0];
    try {
      if (fs.existsSync(file.path)) {
        await client.files.uploadV2({ channel_id: t.channel, thread_ts: t.threadTs, file: file.path, filename: file.name });
      }
      f.uploaded = (f.uploaded || 0) + 1;
      f.uploadFails = 0;
      store.save();
    } catch (err) {
      const why = err.data?.error || err.message;
      f.uploadFails = (f.uploadFails || 0) + 1;
      store.save();
      log(`[upload] ${keyOf(t.channel, t.threadTs)} ${file.name} failed (${f.uploadFails}): ${why}`);
      // Permission errors won't fix themselves on a retry; network blips might.
      if (f.uploadFails < 5 && !/missing_scope|not_allowed|not_in_channel|channel_not_found|invalid_auth/.test(why)) return false;
      await safe(() => client.chat.postMessage({ channel: t.channel, thread_ts: t.threadTs, text: `Couldn't upload ${file.name} here (${why}).` }), 'post');
      f.uploaded = (f.uploaded || 0) + 1;
      f.uploadFails = 0;
      store.save();
    }
  }
  return true;
}

// Runs up to MAX_PARALLEL jobs at once, one per thread, oldest request first.
function pump() {
  while (running.size < config.maxParallel) {
    const next = Object.entries(state.threads)
      .filter(([k, t]) => t.pending.length && !t.finalPending && !running.has(k))
      .sort((a, b) => a[1].pending[0].queuedAt - b[1].pending[0].queuedAt)[0];
    if (!next) return;
    const [k, t] = next;
    running.set(k, { stop: () => {} });
    runJob(k, t)
      .catch(async (err) => {
        // Last-resort net: whatever happened, the thread still gets an answer.
        log(`[job] ${k} crashed:`, err.stack || err.message);
        t.finalPending ??= { text: `Something broke on my side before I could finish: ${err.message}. Reply here to retry.`, ok: false, msgTs: [t.reactTs].filter(Boolean), posted: 0 };
        t.inflight = null;
        // Close the run window, or later asks in this thread would be taken for echoes of it.
        if (t.lastRun && !t.lastRun.end) t.lastRun.end = Date.now();
        store.save();
        await deliver(t);
      })
      .finally(() => {
        running.delete(k);
        setImmediate(pump);
      });
  }
}

// ---- catch-up for anything missed while offline --------------------------------

async function listConversations() {
  const out = [];
  let cursor;
  do {
    const res = await client.users.conversations({ types: 'public_channel,private_channel,im,mpim', exclude_archived: true, limit: 200, cursor });
    out.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return out;
}

const THREAD_LOOKBACK_S = 2 * 24 * 3600;

async function catchUp() {
  const late = (ts) => Date.now() / 1000 - Number(ts) > 120;
  const startedAt = Date.now();
  // Live events only go missing while catch-ups fail (offline), so the untracked-thread sweep covers the
  // time since the last catch-up that worked. On first run there is no gap to cover.
  const sweepFrom = (state.lastCatchUpAt || startedAt) / 1000 - 600;
  try {
    for (const c of await listConversations()) {
      const oldest = state.lastSeen[c.id];
      if (!oldest) {
        state.lastSeen[c.id] = String(Date.now() / 1000); // first sight: start watching from now
        continue;
      }
      // Page through everything since we last looked, so a long offline window drops nothing. The window
      // also reaches back THREAD_LOOKBACK_S so threads started earlier show up with their latest_reply.
      const from = String(Math.min(Number(oldest), Date.now() / 1000 - THREAD_LOOKBACK_S));
      const msgs = [];
      let cursor;
      do {
        const hist = await client.conversations.history({ channel: c.id, oldest: from, limit: 200, cursor });
        msgs.push(...(hist.messages || []));
        cursor = hist.response_metadata?.next_cursor;
      } while (cursor);
      // Replies tagging the bot in threads it was never in, sent while live events weren't arriving.
      const since = String(Math.max(Number(oldest), sweepFrom));
      for (const threadTs of threadsWithNewReplies(msgs, since, (ts) => state.threads[keyOf(c.id, ts)])) {
        const res = await safe(() => client.conversations.replies({ channel: c.id, ts: threadTs, oldest: since, limit: 200 }), 'replies');
        for (const m of res?.messages || []) {
          if (m.ts === threadTs || Number(m.ts) <= Number(since)) continue;
          if (m.bot_id || (m.subtype && m.subtype !== 'file_share') || isCommand(m.text)) continue;
          if (!addressedToBot({ channel: c.id, text: m.text })) continue;
          await incoming({ channel: c.id, ts: m.ts, threadTs, user: m.user, text: m.text, files: m.files, caughtUp: late(m.ts) });
        }
      }
      let newest = oldest;
      for (const m of msgs.filter((x) => Number(x.ts) > Number(oldest)).sort((a, b) => Number(a.ts) - Number(b.ts))) {
        if (Number(m.ts) > Number(newest)) newest = m.ts;
        if (m.bot_id || (m.subtype && m.subtype !== 'file_share')) continue;
        if (isCommand(m.text)) continue; // !comms / !join were answered live; never replay them as tasks
        if (c.is_im || m.text?.includes(`<@${botUserId}>`)) {
          await incoming({ channel: c.id, ts: m.ts, threadTs: m.thread_ts, user: m.user, text: m.text, files: m.files, caughtUp: late(m.ts) });
        }
      }
      state.lastSeen[c.id] = newest;
    }
    // Replies inside threads we're working in (these don't show up in channel history).
    const cutoff = Date.now() - 3 * 24 * 3600_000;
    for (const t of Object.values(state.threads)) {
      if (t.lastActivity < cutoff) continue;
      const res = await safe(() => client.conversations.replies({ channel: t.channel, ts: t.threadTs, oldest: t.lastReplySeen || t.threadTs, limit: 200 }), 'replies');
      for (const m of res?.messages || []) {
        if (m.ts === t.threadTs) continue;
        if (Number(m.ts) > Number(t.lastReplySeen || 0)) t.lastReplySeen = m.ts;
        if (m.bot_id || (m.subtype && m.subtype !== 'file_share')) continue;
        if (isCommand(m.text)) continue;
        if (!addressedToBot({ channel: t.channel, threadTs: t.threadTs, text: m.text })) continue;
        await incoming({ channel: t.channel, ts: m.ts, threadTs: t.threadTs, user: m.user, text: m.text, files: m.files, caughtUp: late(m.ts) });
      }
    }
    state.lastCatchUpAt = startedAt;
    store.save();
  } catch (err) {
    log('[catchup] failed:', err.data?.error || err.message);
  }
}

// ---- boot -------------------------------------------------------------------

async function main() {
  const auth = await client.auth.test();
  botUserId = auth.user_id;
  const scopes = auth.response_metadata?.scopes || [];
  if (scopes.length && !scopes.includes('files:write')) log('[boot] no files:write scope: renders and images can\'t be uploaded to threads (add it in the Slack app, then reinstall)');
  teamId = auth.team_id;

  // Anything that was running when we died goes back on the queue, first in line.
  for (const t of Object.values(state.threads)) {
    // A run cut off by a crash with nothing to resume never got its end: close it (see the echo check).
    // Its last activity is the best guess at when it stopped, so asks sent while the bot was down still count.
    if (!t.inflight?.length && t.lastRun && !t.lastRun.end) t.lastRun.end = Math.max(t.lastRun.start, Math.min(t.lastActivity || Date.now(), Date.now()));
    if (t.inflight?.length) {
      t.pending = [...t.inflight.map((m) => ({ ...m, resumed: true, queuedAt: 0 })), ...t.pending];
      t.inflight = null;
    }
  }
  store.save();

  await app.start();
  log(`[boot] ${config.botName} connected as ${auth.user} (${botUserId}) in ${auth.team}; claude=${[].concat(config.claudeBin).join(' ')} mode=${config.permissionMode} model=${config.defaultModel}`);

  for (const t of Object.values(state.threads)) await deliver(t);
  await catchUp();
  pump();

  setInterval(() => {
    for (const t of Object.values(state.threads)) if (t.finalPending && !running.has(keyOf(t.channel, t.threadTs))) deliver(t);
  }, 60_000);
  setInterval(() => catchUp().then(pump), config.catchUpMin * 60_000);

  addons.start({
    client,
    runClaude,
    claudeOpts: { bin: config.claudeBin, permissionMode: config.permissionMode, chrome: config.chrome, extraArgs: config.claudeExtraArgs, disallowedTools: SELF_PROTECT, env: RUN_ENV },
    enqueue: (m) => incoming({ ...m, defer: true }),
    pump,
    botUserId: () => botUserId,
    teamId,
    log,
  });

  // AUTO_UPDATE=1 (copies of the public ai-me repo): pull new code while idle, then exit so the
  // service restarts on it. Never mid-task, and nothing to resume because nothing is running.
  if (config.autoUpdate) {
    const updateTick = () => {
      const idle = running.size === 0 && activeRuns() === 0 && !lessonsBusy && Object.values(state.threads).every((t) => !t.pending.length && !t.inflight && !t.finalPending);
      if (!idle || !updateDue(state.updateCheckedAt)) return;
      state.updateCheckedAt = Date.now();
      store.save();
      if (selfUpdate({ root: config.root, log })) process.exit(0);
    };
    setInterval(updateTick, 10 * 60_000);
  }

  // Daily lessons DM (see src/lessons.js). The date is claimed before the run, so it never posts twice.
  if (config.lessonsHour != null) {
    const lessonsTick = () => {
      const today = lessonsDue(state.lessonsDate, config.lessonsHour);
      if (!today) return;
      state.lessonsDate = today;
      store.save();
      lessonsBusy = true;
      reviewLessons({ client, config, state, botUserId, since: Date.now() - 24 * 3600_000, log }).finally(() => { lessonsBusy = false; });
    };
    lessonsTick();
    setInterval(lessonsTick, 10 * 60_000);
  }
}

process.on('unhandledRejection', (err) => log('[unhandled]', err?.stack || err));
main().catch((err) => {
  log('[boot] failed:', err.data?.error || err.stack || err.message);
  process.exit(1);
});
