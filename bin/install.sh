#!/bin/zsh
# Installs (or reinstalls) the bot as a macOS login service that restarts itself.
# Usage: bin/install.sh            install + start
#        bin/install.sh uninstall  stop + remove
set -euo pipefail

ROOT=${0:A:h:h}
LABEL="com.$(whoami).$(basename "$ROOT")"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

[[ -f "$ROOT/.env" ]] || { echo "Missing $ROOT/.env (copy .env.example and fill it in)"; exit 1; }
NODE=$(/bin/zsh -lc 'whence -p node')
CLAUDE=$(/bin/zsh -lc 'whence -p claude' || true)
[[ -n "$NODE" ]] || { echo "node not found on your login PATH"; exit 1; }
[[ -n "$CLAUDE" ]] || { echo "claude not found on your login PATH"; exit 1; }
LOGIN_PATH=$(/bin/zsh -lc 'echo $PATH')

mkdir -p "$ROOT/logs" "$ROOT/data" "$HOME/Library/LaunchAgents"
# Tokens, message history and logs are readable by this user only.
chmod 600 "$ROOT/.env"
chmod -R go-rwx "$ROOT/logs" "$ROOT/data"
(cd "$ROOT" && "$NODE" "$(dirname "$NODE")/npm" ci --omit=dev --silent 2>/dev/null || "$NODE" "$(dirname "$NODE")/npm" install --omit=dev --silent)

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file=$ROOT/.env</string>
    <string>$ROOT/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$LOGIN_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>CLAUDE_BIN</key><string>$CLAUDE</string>
  </dict>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/bot.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/bot.log</string>
</dict>
</plist>
EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "Installed $LABEL. Logs: $ROOT/logs/bot.log"
sleep 4
tail -n 5 "$ROOT/logs/bot.log" || true
