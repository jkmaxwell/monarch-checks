#!/bin/sh
# Run scripts/monarch-mcp-http.sh as a macOS LaunchAgent: starts at login,
# restarts if it exits. Same port/dir defaults as the script itself.
#
#   ALLY_CHECKS_EXTENSION_ID=<id> scripts/install-autostart.sh  # install/reinstall + start
#   scripts/install-autostart.sh --uninstall                     # stop + remove
#
# The extension ID is baked into the agent (see monarch-mcp-http.sh for why);
# re-run this if the ID changes (e.g. the extension is loaded from a new path).
#
# Logs: ~/Library/Logs/monarch-mcp-http.log
# After re-running login_setup.py, restart it to pick up the new session:
#   launchctl kickstart -k gui/$(id -u)/com.monarch-checks.mcp-http
set -e
LABEL=com.monarch-checks.mcp-http
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/monarch-mcp-http.sh"
LOG="$HOME/Library/Logs/monarch-mcp-http.log"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the job is gone; bootstrapping too soon fails with
# "Bootstrap failed: 5: Input/output error". Wait (up to ~10s) for it to clear.
i=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $i -lt 20 ]; do
  sleep 0.5; i=$((i + 1))
done
if [ "$1" = "--uninstall" ]; then
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

if [ -z "$ALLY_CHECKS_EXTENSION_ID" ]; then
  echo "Set ALLY_CHECKS_EXTENSION_ID to the extension's ID (dia://extensions or chrome://extensions)." >&2
  exit 1
fi

# launchd starts with a bare PATH; uv usually lives in Homebrew's bin.
UV_DIR="$(dirname "$(command -v uv)")"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$SCRIPT</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$UV_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ALLY_CHECKS_EXTENSION_ID</key><string>$ALLY_CHECKS_EXTENSION_ID</string>
    <key>MONARCH_MCP_DIR</key><string>${MONARCH_MCP_DIR:-$HOME/dev/monarch-mcp-server}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL — logs at $LOG"
