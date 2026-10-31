// Outbox: files a run wants the people in the thread to see (renders, generated images, screenshots).
// Claude Code writes them into the thread's outbox folder ($AI_SLACK_OUTBOX); after the final reply
// is posted, the bot uploads each one into the thread so it shows inline and can be downloaded.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILES = 10;
export const MAX_BYTES = 1024 ** 3; // Slack's per-file limit

export function outboxDir(dataDir, channel, threadTs) {
  return path.join(dataDir, 'outbox', `${channel}-${String(threadTs).replace('.', '-')}`);
}

// A fresh run starts with an empty outbox; a resumed run keeps what it already rendered.
export function prepareOutbox(dir, { resumed = false } = {}) {
  if (!resumed) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// What to upload, oldest first. Hidden and partial files are ignored; folders are searched,
// so an unzipped export works too. Returns { files: [{ path, name, size }], skipped: [reason] }.
export function collectOutbox(dir) {
  const found = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '__MACOSX' || /\.(part|tmp|crdownload|zip)$/i.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        found.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(dir);
  found.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  const files = [];
  const skipped = [];
  for (const f of found) {
    if (!f.size) continue;
    if (f.size > MAX_BYTES) skipped.push(`${f.name} is over Slack's 1 GB limit`);
    else if (files.length >= MAX_FILES) skipped.push(`${f.name} (only ${MAX_FILES} files per reply)`);
    else files.push({ path: f.path, name: f.name, size: f.size });
  }
  return { files, skipped };
}

export function clearOutbox(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
