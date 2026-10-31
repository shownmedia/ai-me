// Self-update for copies of the public ai-me repo (AUTO_UPDATE=1). The bot calls selfUpdate while idle;
// it fast-forwards to the upstream branch, reinstalls packages if the lockfile changed, and returns true
// so the caller can exit and the login service restarts on the new code. Any failure leaves the old
// code and packages in place, so a bad step never strands the bot.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const UPDATE_EVERY_MS = 6 * 3600_000;

export function updateDue(lastCheckedAt, now = Date.now()) {
  return !lastCheckedAt || now - lastCheckedAt >= UPDATE_EVERY_MS;
}

// npm's CLI script next to this node (the Node installer/zip on Windows; Homebrew, nvm, the tarball on macOS).
export function npmCli(nodePath = process.execPath, exists = fs.existsSync) {
  const dir = path.dirname(nodePath);
  return [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((p) => exists(p));
}

const defaultRun = (root) => (cmd, args, timeout = 60_000) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function selfUpdate({ root, log = console.log, run = defaultRun(root), npm = npmCli() }) {
  const git = (...args) => run('git', args);
  const why = (err) => (err.stderr || err.message || '').toString().trim().split('\n')[0];
  try {
    git('fetch', '--quiet');
    const head = git('rev-parse', 'HEAD');
    const upstream = git('rev-parse', '@{u}');
    if (head === upstream) return false;
    try {
      git('merge-base', '--is-ancestor', 'HEAD', '@{u}');
    } catch {
      log('[update] local commits differ from upstream, not updating (reset to upstream to get updates again)');
      return false;
    }
    const lockChanged = git('diff', '--name-only', head, upstream).split('\n').includes('package-lock.json');
    if (lockChanged && !npm) {
      log("[update] new packages needed but npm wasn't found next to node, not updating (re-run setup)");
      return false;
    }
    // New packages are installed into a staging folder first (npm ci wipes node_modules before it
    // installs), so a failed install changes nothing and the swap below is two renames.
    const stage = path.join(root, 'data', 'update-stage');
    if (lockChanged) {
      try {
        fs.rmSync(stage, { recursive: true, force: true });
        fs.mkdirSync(stage, { recursive: true });
        for (const f of ['package.json', 'package-lock.json']) fs.writeFileSync(path.join(stage, f), git('show', `${upstream}:${f}`));
        run(process.execPath, [npm, 'ci', '--omit=dev', '--silent', '--prefix', stage], 300_000);
      } catch (err) {
        fs.rmSync(stage, { recursive: true, force: true });
        log(`[update] package install failed, staying on ${head.slice(0, 7)}: ${why(err)}`);
        return false;
      }
    }
    git('merge', '--ff-only', '--quiet', '@{u}');
    if (lockChanged) {
      const live = path.join(root, 'node_modules');
      fs.rmSync(`${live}.old`, { recursive: true, force: true });
      if (fs.existsSync(live)) fs.renameSync(live, `${live}.old`);
      fs.renameSync(path.join(stage, 'node_modules'), live);
      fs.rmSync(`${live}.old`, { recursive: true, force: true });
      fs.rmSync(stage, { recursive: true, force: true });
    }
    log(`[update] ${head.slice(0, 7)} -> ${upstream.slice(0, 7)}, restarting`);
    return true;
  } catch (err) {
    log(`[update] skipped: ${why(err)}`);
    return false;
  }
}
