#!/bin/bash
# AI <You>: your own Claude Code in Slack. One command on a Mac:
#
#   curl -fsSL https://raw.githubusercontent.com/shownmedia/ai-me/main/setup.sh | bash
#
# Installs what's missing (Apple's developer tools, Node, Claude Code), downloads the bot to ~/ai-me,
# then opens Claude Code, which builds your Slack bot with you (SETUP.md). No admin password, no GitHub
# account. Safe to run again: it skips what's done, and on an existing bot it updates and re-checks it.
set -euo pipefail

REPO=${AI_ME_REPO:-https://github.com/shownmedia/ai-me.git}
DIR="$HOME/ai-me"
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname)" = "Darwin" ] || { echo "This one is for Macs. On Windows, open PowerShell and run:"; echo "  irm https://raw.githubusercontent.com/shownmedia/ai-me/main/setup.ps1 | iex"; exit 1; }
# curl | bash leaves stdin as the script; Claude Code needs the keyboard.
[ -n "${AI_ME_NO_CLAUDE:-}" ] || exec </dev/tty

bold "Setting up your AI bot for Slack. About 10 minutes, most of it Claude doing the work."

# 1. Apple's developer tools (git)
if ! xcode-select -p >/dev/null 2>&1; then
  bold "Installing Apple's developer tools. A popup opens: click Install, wait for it to finish, then run the same command again."
  xcode-select --install >/dev/null 2>&1 || true
  exit 0
fi

# 2. Node 20.6+ (a private copy in ~/.ai-me/node when there isn't one, so no password is needed)
node_ok() { has node && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=6)?0:1)'; }
export PATH="$HOME/.ai-me/node/bin:$HOME/.local/bin:$PATH"
if ! node_ok; then
  bold "Installing Node"
  ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH=x64
  VER=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["lts"]))')
  mkdir -p "$HOME/.ai-me" && rm -rf "$HOME/.ai-me/node"
  curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-darwin-$ARCH.tar.gz" | tar -xz -C "$HOME/.ai-me"
  mv "$HOME/.ai-me/node-$VER-darwin-$ARCH" "$HOME/.ai-me/node"
fi

# 3. Claude Code (native installer, updates itself)
if ! has claude; then
  bold "Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
fi
for f in "$HOME/.zprofile" "$HOME/.zshrc"; do
  grep -q 'ai-me/node/bin' "$f" 2>/dev/null || echo 'export PATH="$HOME/.ai-me/node/bin:$HOME/.local/bin:$PATH"' >> "$f"
done

# 4. The bot itself
if [ -e "$DIR" ] && ! git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
  mv "$DIR" "$DIR.broken-$(date +%s)"   # a half-finished earlier download: start over, keep it just in case
fi
if [ -d "$DIR/.git" ]; then
  bold "Updating the bot in ~/ai-me"
  git -C "$DIR" pull --ff-only --quiet || echo "(couldn't update ~/ai-me, Claude will look at it)"
else
  bold "Downloading the bot to ~/ai-me"
  git clone --quiet "$REPO" "$DIR"
fi
(cd "$DIR" && npm ci --omit=dev --silent)

# 5. Shown's Claude Code default: no permission prompt before every step (same as Shown setup).
python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
os.makedirs(os.path.dirname(p), exist_ok=True)
s = json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
s.setdefault("permissions", {})["defaultMode"] = "bypassPermissions"
s["skipDangerousModePermissionPrompt"] = True
json.dump(s, open(p, "w"), indent=2)
PY

[ -z "${AI_ME_NO_CLAUDE:-}" ] || { echo "setup.sh: done (AI_ME_NO_CLAUDE set, not opening Claude)"; exit 0; }
bold "Claude Code opens next. If it asks you to log in, use your Shown Claude account (ask Dylan Crispin if you don't have one)."
echo "Then just answer its questions. It makes the Slack app, connects your tools and tests the bot with you."
sleep 2
cd "$DIR"
exec claude "Set up my AI bot."
