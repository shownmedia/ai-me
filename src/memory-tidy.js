// Nightly memory tidy, right after the daily lessons (Mitchell 2026-11-26): the lessons only ever add notes, and
// Claude Code reads just the first 25KB / 200 lines of MEMORY.md, so without this new rules silently fall off the end.
// One Claude run merges duplicates, retires notes about things that are gone, links related notes and keeps the
// index under budget. The memory folder is backed up first (data/memory-backups, last 14 kept), so a bad night undoes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runClaude, RUN_ENV, SELF_PROTECT } from './claude.js';
import { memoryIndexPath } from './lessons.js';

export const INDEX_BUDGET = 20_000; // bytes; the load limit is 25KB, the rest is room for tomorrow's lessons
export const KEEP_BACKUPS = 14;

export function tidyPrompt(memoryDir, ownerName) {
  return `You keep ${ownerName}'s Claude Code memory in ${memoryDir} healthy. Its index, MEMORY.md, is loaded into every session but only up to 25KB and 200 lines, and it is now ${'${SIZE}'} bytes. Each other .md file is one memory with frontmatter (name, description, metadata.type: user | feedback | project | reference) and a body that links related memories as [[name]].

Tonight's job, in this order:
1. Merge duplicates: memories that state the same rule or fact become one file (keep the clearer wording, union the Why/How to apply lines, delete the other file, fix its index line and any [[links]] to it).
2. Retire what is gone: a memory that names a file, repo, flag, channel or service that no longer exists (check with ls/grep; don't guess) gets updated to what is true now, or deleted if nothing of it still applies. Paused or dead projects stay, under "Paused / dead".
3. Link: add links between memories that are clearly about the same thing, in the body only, written as [[file name without .md]] (e.g. [[feedback_fo_spelling]]) so they open in Obsidian. Fix older [[links]] that don't match a file name the same way.
4. Index: every memory file has exactly one index line and every index line points at a file that exists. Shorten long index lines to the hook a future session needs to decide whether to open the file; the detail lives in the file. Get MEMORY.md under ${INDEX_BUDGET} bytes and 200 lines, keeping its sections and their order.

Never:
- lose a rule. A feedback memory is ${ownerName}'s correction: merge it or shorten its index line, but only delete it as a duplicate or when what it is about no longer exists.
- change what a rule says, soften it, or add rules of your own.
- touch anything outside ${memoryDir}, or files there that aren't .md.

End with one line per change: merged a + b, retired x (why), shortened index, linked n notes. Then the final MEMORY.md size in bytes.`;
}

export function backupMemory(memoryDir, backupRoot, stamp = new Date().toISOString().slice(0, 10)) {
  const dest = path.join(backupRoot, stamp);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(memoryDir)) {
    if (f.endsWith('.md')) fs.copyFileSync(path.join(memoryDir, f), path.join(dest, f));
  }
  const old = fs.readdirSync(backupRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, -KEEP_BACKUPS);
  for (const d of old) fs.rmSync(path.join(backupRoot, d), { recursive: true, force: true });
  return dest;
}

export async function tidyMemory({ config, log = () => {} }) {
  const index = memoryIndexPath(config.workdir);
  const dir = path.dirname(index);
  if (!fs.existsSync(index)) return { ok: false, skipped: 'no memory yet' };
  try {
    const before = fs.statSync(index).size;
    const backup = backupMemory(dir, path.join(config.dataDir, 'memory-backups'));
    const prompt = tidyPrompt(dir, config.ownerName).replace('${SIZE}', String(before));
    const run = await runClaude({ bin: config.claudeBin, cwd: dir, timeoutMin: 45, model: 'opus', permissionMode: 'bypassPermissions', prompt, sessionId: crypto.randomUUID(), env: RUN_ENV, disallowedTools: SELF_PROTECT }).promise;
    const after = fs.existsSync(index) ? fs.statSync(index).size : 0;
    // An index that vanished or lost most of itself is a broken run, not a tidy one: put the night's backup back.
    if (!after || after < before * 0.3) {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) fs.rmSync(path.join(dir, f));
      for (const f of fs.readdirSync(backup)) fs.copyFileSync(path.join(backup, f), path.join(dir, f));
      log(`[memory] tidy restored the backup: index went ${before} -> ${after} bytes`);
      return { ok: false, restored: true };
    }
    log(`[memory] tidy ${run.ok ? 'done' : 'failed'}: index ${before} -> ${after} bytes. ${(run.text || '').replace(/\s+/g, ' ').slice(0, 600)}`);
    return { ok: run.ok, before, after, text: run.text };
  } catch (err) {
    log(`[memory] tidy failed: ${err.message}`);
    return { ok: false };
  }
}
