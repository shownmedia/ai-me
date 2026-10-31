// Tiny durable JSON store. Every write goes to a temp file and is renamed into
// place, so a crash or sleep mid-write never leaves a half-written state file.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = { threads: {}, processed: [], lastSeen: {} };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] could not read state, starting fresh:', err.message);
  }
  const processed = new Set(state.processed);

  function save() {
    state.processed = [...processed].slice(-3000);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    state,
    save,
    seen: (ts) => processed.has(ts),
    markSeen: (ts) => processed.add(ts),
  };
}
