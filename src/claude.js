// Runs one headless Claude Code turn and streams progress back.
// Resolves with { ok, text, sessionStarted, costUsd, denials, timedOut, stopped }.
// onSessionStart fires once, as soon as Claude Code confirms the session exists.
// Never rejects: every failure becomes an { ok: false } result so the caller
// always has something to post back to Slack.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describeTool } from './format.js';

// Windows can't spawn npm's claude.cmd without a shell (and a shell would let Slack text
// inject commands), so an npm install resolves to [node, the package's own entry point].
export function windowsClaude(found, nodeBin = process.execPath) {
  const exe = found.find((p) => /\.exe$/i.test(p));
  if (exe) return exe;
  for (const shim of found) {
    const pkg = path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code');
    try {
      const { bin } = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
      const entry = path.join(pkg, typeof bin === 'string' ? bin : bin.claude);
      return /\.(c|m)?js$/i.test(entry) ? [nodeBin, entry] : entry;
    } catch {}
  }
  return 'claude.exe';
}

// `bin` is the claude executable, or [executable, ...leading args] (e.g. [node, cli.js] on Windows).
// Never spawned through a shell: the prompt is Slack text and must stay a plain argument.
const spawnBin = (bin, args, opts) => {
  const [cmd, ...pre] = [].concat(bin);
  return spawn(cmd, [...pre, ...args], { ...opts, windowsHide: true });
};

// On Windows, kill() only ends claude itself; taskkill /T also ends the tools it started.
export function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
  } else {
    child.kill(signal);
  }
}

// Commands a Slack-driven run may never use: they could stop the bot that's running it.
export const SELF_PROTECT = [
  'Bash(launchctl:*)', 'Bash(pkill:*)', 'Bash(killall:*)', 'Bash(*bin/install.sh*)',
  'Bash(taskkill*)', 'Bash(schtasks*)', 'Bash(*Stop-Process*)', 'Bash(*Unregister-ScheduledTask*)', 'Bash(*install.ps1*)',
];

// Environment for every Slack-driven run.
// - Headless -p runs end when the model stops talking, so a background task would never report back.
// - Parallel runs each start their own Playwright MCP; without isolation they fight over one browser profile
//   ("Browser is already in use"). Logged-in browsing goes through Claude in Chrome instead.
export const RUN_ENV = { AI_SLACK_BOT: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', BASH_DEFAULT_TIMEOUT_MS: '600000', PLAYWRIGHT_MCP_ISOLATED: 'true' };

export function buildArgs({ prompt, sessionId, resume, model, permissionMode, systemPrompt, maxBudgetUsd, chrome = false, disallowedTools = [], extraArgs = '' }) {
  // No model means Claude Code's own default (whatever `claude` uses in a terminal).
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : [])];
  if (permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', permissionMode);
  args.push(...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]));
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  // -p runs skip Claude in Chrome unless asked, so the bot couldn't browse as the owner like a terminal session can.
  if (chrome) args.push('--chrome');
  if (disallowedTools.length) args.push('--disallowedTools', ...disallowedTools);
  args.push(...extraArgs.split(' ').filter(Boolean));
  return args;
}

// Claude runs in progress from any caller (tasks, the lessons DM, add-ons), so nothing restarts the bot under one.
let active = 0;
export const activeRuns = () => active;

export function runClaude({ bin, cwd, timeoutMin, onProgress, onSessionStart, env, ...argOpts }) {
  const args = buildArgs(argOpts);
  let child;
  const result = { ok: false, text: '', sessionStarted: false, costUsd: 0, denials: [], timedOut: false, stopped: false };

  const promise = new Promise((resolve) => {
    let settled = false;
    let ticker;
    let stdoutBuf = '';
    let stderr = '';
    let lastText = '';
    let activeMs = 0;
    let lastTick = Date.now();

    let counted = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (counted) active--;
      clearInterval(ticker);
      if (!result.text) {
        result.text = lastText || (stderr.trim()
          ? `Claude Code exited with an error:\n\`\`\`\n${stderr.trim().slice(-1500)}\n\`\`\``
          : 'Claude Code exited without a reply.');
      }
      resolve(result);
    };

    try {
      child = spawnBin(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      active++;
      counted = true;
    } catch (err) {
      result.text = `Could not start Claude Code: ${err.message}`;
      return finish();
    }

    // Count only time the computer was awake, so a laptop nap doesn't trip the timeout.
    ticker = setInterval(() => {
      const now = Date.now();
      activeMs += Math.min(now - lastTick, 20_000);
      lastTick = now;
      if (activeMs > timeoutMin * 60_000 && !result.timedOut) {
        result.timedOut = true;
        killTree(child);
        setTimeout(() => killTree(child, 'SIGKILL'), 10_000).unref();
      }
    }, 5_000);

    child.stdout.on('data', (d) => {
      stdoutBuf += d;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init' && !result.sessionStarted) {
          result.sessionStarted = true;
          onSessionStart?.(); // lets the caller persist it now, so a crash mid-run resumes instead of re-creating
        }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'tool_use') onProgress?.(describeTool(c.name, c.input));
            if (c.type === 'text' && c.text?.trim()) lastText = c.text.trim();
          }
        }
        if (ev.type === 'result') {
          result.ok = !ev.is_error && ev.subtype === 'success';
          result.text = (ev.result || '').trim() || lastText;
          result.costUsd = ev.total_cost_usd || 0;
          result.denials = ev.permission_denials || [];
          if (!result.ok && ev.subtype && ev.subtype !== 'success') {
            result.text = `${result.text ? `${result.text}\n\n` : ''}(Claude Code stopped: ${ev.subtype})`;
          }
        }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    child.on('error', (err) => { result.text = `Could not start Claude Code: ${err.message}`; finish(); });
    child.on('close', finish);
  });

  return {
    promise,
    stop: () => { result.stopped = true; killTree(child); },
  };
}

// A quick (~3s) guess at how long a task will take (for the Slack status line) and how hard it is
// (to pick the model). Sonnet with calibration anchors; Haiku guessed wildly (90 min to send one message).
// Resolves to { minutes, model } where model is 'opus' | 'sonnet' | null. Never rejects.
const ESTIMATE_PROMPT = [
  'An AI agent (Claude Code) with full access to the user\'s computer, repos, CLIs, Slack and Google will do the task below. It works fast: it reads and searches in seconds and runs tools back to back.',
  'Typical times: answer a question, look something up, or check status across Slack, calendar, email or a database: 1 min. Gather info and send or post a message: 2-3 min. Small code change with tests, push and deploy: 5-10 min. Bigger feature or a bulk data cleanup: 15-30 min. Only huge multi-repo projects take longer. When unsure, guess lower.',
  'Then pick the model. opus: changing code or a bot, building or fixing anything, multi-step work across tools, data cleanup or analysis, writing that has to be good (scripts, docs, copy), anything with images or video. sonnet: a question, a lookup, a status check, sending or scheduling a message, a quick edit to a doc or post.',
  'Reply with only the whole number of minutes and the model, like: 3 sonnet',
  '',
  'Task:',
  '',
].join('\n');

export function parseEstimate(text) {
  const s = String(text ?? '');
  const n = Number(s.match(/\d+/)?.[0]);
  const model = s.match(/\b(opus|sonnet)\b/i)?.[1]?.toLowerCase() || null;
  // Past an hour a guess isn't useful, and it tends to run high.
  return { minutes: n > 0 ? Math.min(n, 60) : null, model };
}

// One quick tool-less, MCP-less answer from Claude (no session kept). Resolves to the text, or null.
export function askClaude({ bin, prompt, model = 'sonnet', timeoutMs = 45_000 }) {
  active++;
  return new Promise((resolve) => {
    let out = '';
    let child;
    const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--tools', ''];
    try {
      child = spawnBin(bin, args, { cwd: os.tmpdir(), env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { killTree(child, 'SIGKILL'); resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(String(JSON.parse(out).result ?? ''));
      } catch {
        resolve(null);
      }
    });
  }).finally(() => { active--; });
}

export async function estimateTask({ bin, task, timeoutMs = 45_000 }) {
  return parseEstimate(await askClaude({ bin, prompt: ESTIMATE_PROMPT + task, timeoutMs }));
}
