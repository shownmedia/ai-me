// Everything person-specific lives in .env so anyone can run their own copy.
// See .env.example for what each value means.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { windowsClaude } from './claude.js';
import { parseLinks } from './format.js';

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findClaude() {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  if (process.platform === 'win32') {
    try {
      return windowsClaude(execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
    } catch {
      return windowsClaude([path.join(os.homedir(), '.local', 'bin', 'claude.exe')].filter((p) => fs.existsSync(p)));
    }
  }
  try {
    return execFileSync('/bin/zsh', ['-lc', 'whence -p claude'], { encoding: 'utf8' }).trim();
  } catch {
    return 'claude';
  }
}

// `Name:Value,Name:Value` → { name (lowercase): value }.
function nameMap(raw) {
  return Object.fromEntries(
    String(raw || '')
      .split(',')
      .map((p) => p.split(':').map((s) => s.trim()))
      .filter(([n, v]) => n && v)
      .map(([n, v]) => [n.toLowerCase(), v]),
  );
}

const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'OWNER_SLACK_ID'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`[config] missing ${missing.join(', ')} in .env (see .env.example)`);
  process.exit(1);
}

export const config = {
  root,
  botToken: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  ownerId: env.OWNER_SLACK_ID,
  ownerName: env.OWNER_NAME || 'the owner',
  botName: env.BOT_NAME || 'AI Me',
  claudeBin: findClaude(),
  workdir: (env.WORKDIR || os.homedir()).replace(/^~/, os.homedir()),
  defaultModel: env.DEFAULT_MODEL || 'sonnet', // aliases track the newest Sonnet / Opus automatically
  opusModel: env.OPUS_MODEL || 'opus',
  // Each thread's first run picks Sonnet or Opus from the task ("use opus"/"use sonnet" still pins it). AUTO_MODEL=0 turns it off.
  autoModel: !/^(0|false|no)$/i.test(env.AUTO_MODEL || ''),
  permissionMode: env.PERMISSION_MODE || 'bypassPermissions',
  timeoutMin: Number(env.TIMEOUT_MIN || 60),
  maxBudgetUsd: env.MAX_BUDGET_USD || '',
  claudeExtraArgs: env.CLAUDE_EXTRA_ARGS || '',
  // Claude in Chrome (the owner's logged-in browser). On unless CHROME=0.
  chrome: !/^(0|false|no)$/i.test(env.CHROME || ''),
  dataDir: path.resolve(root, env.DATA_DIR || 'data'),
  // Guest threads (owner-approved teammates who may task the bot in one thread, scoped to one folder).
  guestsFile: path.resolve(root, env.GUESTS_FILE || 'guests.json'),
  catchUpMin: Number(env.CATCHUP_MIN || 5),
  denyEmoji: env.DENY_EMOJI || 'no_entry_sign',
  workingEmoji: env.WORKING_EMOJI || 'eyes',
  finishedEmoji: env.FINISHED_EMOJI || 'white_check_mark',
  doneEmoji: env.DONE_EMOJI || '',
  // Clean Up (src/cleanup.js): a finished thread folds into one summary message this many minutes after
  // its last activity; CLEANUP_AFTER_MIN=off leaves threads alone ("clean up" in a thread still works).
  // Deleting the owner's messages needs their user token (xoxp, user scope chat:write); without it nothing is cleaned.
  userToken: env.SLACK_USER_TOKEN || '',
  // One bot message per thread: the status line and every answer edit it instead of posting new messages.
  // Edits don't notify, so the ✅ on your ask is the done signal. EDIT_IN_PLACE=1 turns it on.
  editInPlace: /^(1|true|yes)$/i.test(env.EDIT_IN_PLACE || ''),
  cleanupAfterMin: /^(off|no|false)$/i.test(env.CLEANUP_AFTER_MIN || '') ? null : Math.max(1, Number(env.CLEANUP_AFTER_MIN || 60)),
  lowercase: /^(1|true|yes)$/i.test(env.LOWERCASE || ''),
  // Hour (local, 0-23) of the daily lessons DM; LESSONS_HOUR=off turns it off.
  // Lessons are saved to memory when the DM goes out; LESSONS_AUTOSAVE=off goes back to "reply save".
  lessonsAutoSave: !/^(off|no|false)$/i.test(env.LESSONS_AUTOSAVE || ''),
  lessonsHour: /^(off|no|false)$/i.test(env.LESSONS_HOUR || '') ? null : Math.min(23, Math.max(0, Number(env.LESSONS_HOUR || 21))),
  maxParallel: Math.max(1, Number(env.MAX_PARALLEL || 3)),
  // Pull new code from the repo it was cloned from, while idle, and restart on it (src/update.js).
  autoUpdate: /^(1|true|yes)$/i.test(env.AUTO_UPDATE || ''),
  // Launch recaps (src/recaps.js): off unless RECAPS_ENABLED=1. RECAPS_CHANNEL defaults to #launches-bots.
  recapsEnabled: /^(1|true|yes)$/i.test(env.RECAPS_ENABLED || ''),
  // A QA run checks and fixes every recap before it posts (src/recap-prompts.js qaPrompt). RECAP_QA=off skips it.
  recapQa: !/^(0|off|false|no)$/i.test(env.RECAP_QA || ''),
  recapsChannel: env.RECAPS_CHANNEL || 'C0C9ML7MKBL',
  // Who gets asked for a launch's main post when it can't be found: `Name:SlackID,Name:SlackID`,
  // keyed by Lumen's Outreach Specialist names. Unknown names fall back to OWNER_SLACK_ID.
  outreachSlackIds: nameMap(env.OUTREACH_SLACK_IDS),
  // Who the 24h/48h recap posts tag: the launch's Launch Strategist (Slack id from Lumen's launch-team
  // API, key LUMEN_LAUNCH_TEAM_KEY), Growth Engineer (GROWTH_SLACK_IDS, names as in Lumen; a launch with
  // none falls back to its pod's, POD_GROWTH_ENGINEERS=1:Sebastian,…) and Outreach Specialist (above).
  growthSlackIds: nameMap(env.GROWTH_SLACK_IDS),
  podGrowthEngineers: nameMap(env.POD_GROWTH_ENGINEERS),
  launchTeamKey: env.LUMEN_LAUNCH_TEAM_KEY || '',
  lumenUrl: env.LUMEN_URL || 'https://lumen.shownmedia.com',
  // Answer teammates' status questions when they tag the owner, and remind assignees the day before a
  // due date the owner set (src/assist.js, add-on). On by default; STAND_IN=off / DUE_REMINDERS=off.
  standIn: !/^(off|0|false|no)$/i.test(env.STAND_IN || ''),
  dueReminders: !/^(off|0|false|no)$/i.test(env.DUE_REMINDERS || ''),
  // Draft watch (src/draft-watch.js): creators whose live post isn't their draft, flagged in #influencers-general.
  // Runs with the recaps (same Lumen key). DRAFT_WATCH=off stops it.
  draftWatch: { enabled: !/^(off|0|false|no)$/i.test(env.DRAFT_WATCH || ''), channel: env.DRAFT_WATCH_CHANNEL || 'C0AMVPTGTHP' },
  // Sweeper DMs (src/sweeper.js): off unless SWEEPER_ENABLED=1. Hours are New York, weekdays.
  sweeper: {
    enabled: /^(1|true|yes)$/i.test(env.SWEEPER_ENABLED || ''),
    hours: String(env.SWEEPER_HOURS || '12').split(',').map((h) => h.trim()).filter(Boolean).map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),
    max: Number(env.SWEEPER_MAX) > 0 ? Number(env.SWEEPER_MAX) : 15,
    repeatDays: Number(env.SWEEPER_REPEAT_DAYS) >= 0 && env.SWEEPER_REPEAT_DAYS ? Number(env.SWEEPER_REPEAT_DAYS) : 3,
    channel: env.SWEEPER_CHANNEL || '',
    example: env.SWEEPER_EXAMPLE || '',
    // Slack ids never tagged in a sweeper message (on top of the names in src/sweeper.js NEVER_TAG).
    neverTag: String(env.SWEEPER_NEVER_TAG || '').split(',').map((s) => s.trim()).filter(Boolean),
    timeoutMin: Number(env.SWEEPER_TIMEOUT_MIN || 90),
  },
  // Next steps (src/next-steps.js): off unless NEXT_STEPS_ENABLED=1. After a Fathom 1:1 with a teammate, their
  // action items go to them in a DM from the owner's account; drafts only until NEXT_STEPS_REVIEW_UNTIL (YYYY-MM-DD).
  nextSteps: {
    enabled: /^(1|true|yes)$/i.test(env.NEXT_STEPS_ENABLED || ''),
    fathomKey: env.FATHOM_API_KEY || '',
    ownerEmail: (env.OWNER_EMAIL || '').toLowerCase(),
    reviewUntil: env.NEXT_STEPS_REVIEW_UNTIL || '',
  },
  // Sales concepts (src/sales-concepts.js): off unless SALES_CONCEPTS_ENABLED=1. Proven launch concepts
  // added to a prospect call's brief doc when the SDR shares one, or LEAD_HOURS before a sales call.
  salesConcepts: {
    enabled: /^(1|true|yes)$/i.test(env.SALES_CONCEPTS_ENABLED || ''),
    from: String(env.SALES_CONCEPTS_FROM || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    sdrName: env.SALES_CONCEPTS_SDR_NAME || 'the SDR',
    team: String(env.SALES_CONCEPTS_TEAM || env.SALES_CONCEPTS_FROM || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    leadHours: Number(env.SALES_CONCEPTS_LEAD_HOURS || 72),
    // Guests from these domains (plus the sales team's) are never the prospect.
    internal: String(env.SALES_CONCEPTS_INTERNAL_DOMAINS || 'shownmedia.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    startHour: Number(env.SALES_CONCEPTS_START_HOUR || 8),
    endHour: Number(env.SALES_CONCEPTS_END_HOUR || 21),
    refsDir: (env.SALES_CONCEPTS_REFS || path.join(os.homedir(), 'social-watch', '.claude', 'skills', 'script-studio', 'data')).replace(/^~/, os.homedir()),
    timeoutMin: Number(env.SALES_CONCEPTS_TIMEOUT_MIN || 60),
    // The owner's running sales master doc: each call becomes a recap tab (from Attio) with a concepts
    // child tab, and the SDR gets the link by DM. Unset = concepts go in the SDR's brief doc as before.
    masterDoc: env.SALES_MASTER_DOC_ID || '',
    sdrSlackId: env.SALES_CONCEPTS_SDR_SLACK_ID || '',
  },
  // Weekly game tape (src/game-tape.js): off unless GAME_TAPE_ENABLED=1. Times are New York.
  gameTape: {
    enabled: /^(1|true|yes)$/i.test(env.GAME_TAPE_ENABLED || ''),
    reviewers: String(env.GAME_TAPE_REVIEWERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    channel: env.GAME_TAPE_CHANNEL || '',
    holidays: String(env.GAME_TAPE_HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean),
    genHour: Number(env.GAME_TAPE_GEN_HOUR || 12),
    postHour: Number(env.GAME_TAPE_POST_HOUR || 17),
    postTime: env.GAME_TAPE_POST_TIME || '10:30',
    timeoutMin: Number(env.GAME_TAPE_TIMEOUT_MIN || 240),
    teamId: '',
  },
  // Weekly hiring tape: the same loop over the hiring team's recorded candidate calls (ATS).
  hiringTape: {
    enabled: /^(1|true|yes)$/i.test(env.HIRING_TAPE_ENABLED || ''),
    reviewers: String(env.HIRING_TAPE_REVIEWERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    channel: env.HIRING_TAPE_CHANNEL || '',
    holidays: String(env.GAME_TAPE_HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean),
    genHour: Number(env.HIRING_TAPE_GEN_HOUR || 11),
    postHour: Number(env.HIRING_TAPE_POST_HOUR || 15),
    postTime: env.HIRING_TAPE_POST_TIME || '09:00',
    timeoutMin: Number(env.HIRING_TAPE_TIMEOUT_MIN || 240),
    atsUrl: env.ATS_URL || '',
    standard: env.HIRING_TAPE_STANDARD || path.join(os.homedir(), '.shown', 'hiring-tape', 'STANDARD.md'),
    renderer: env.HIRING_TAPE_RENDERER || path.join(os.homedir(), '.shown', 'hiring-tape', 'render.py'),
    teamId: '',
  },
  // !comms: one reminder for DMs ("take it to a channel") and one for channels ("reply in threads").
  // Links are `label|url;label|url`; COMMS_LINKS (or COMMS_LINK_URL/COMMS_LINK_LABEL) is the fallback for both.
  comms: (() => {
    const all = parseLinks(env.COMMS_LINKS || (env.COMMS_LINK_URL && `${env.COMMS_LINK_LABEL || 'comms-guidelines'}|${env.COMMS_LINK_URL}`));
    return {
      enabled: Boolean(all.length || env.COMMS_DM_LINKS || env.COMMS_THREAD_LINKS),
      dm: { text: env.COMMS_DM_TEXT || 'work talk goes in channels, not DMs', links: env.COMMS_DM_LINKS ? parseLinks(env.COMMS_DM_LINKS) : all },
      thread: { text: env.COMMS_THREAD_TEXT || 'messages should be in threads, not new messages', links: env.COMMS_THREAD_LINKS ? parseLinks(env.COMMS_THREAD_LINKS) : all },
    };
  })(),
};
