#!/bin/sh
# One-shot setup for the Check Payee to Monarch extension.
#
# Does the parts that CAN be scripted:
#   1. checks for Homebrew + git, installs uv if missing
#   2. clones robcerda/monarch-mcp-server to ~/dev/monarch-mcp-server (if absent)
#   3. runs its login_setup.py so your Monarch session lands in the keychain
#
# Then prints the manual steps that CAN'T be scripted (browser + Settings).
# Re-running is safe: every step is skipped if already done.
#
# Usage:  ./setup.sh
set -e

MCP_DIR="${MONARCH_MCP_DIR:-$HOME/dev/monarch-mcp-server}"
MCP_REPO="https://github.com/robcerda/monarch-mcp-server"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31mx\033[0m %s\n' "$1" >&2; exit 1; }

# 1. Prerequisites -----------------------------------------------------------
say "Checking prerequisites"

command -v git >/dev/null 2>&1 || die "git not found. Install Xcode command-line tools: xcode-select --install"

if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew not found. Install it from https://brew.sh, then re-run ./setup.sh"
fi
echo "  git   ok"
echo "  brew  ok"

if command -v uv >/dev/null 2>&1; then
  echo "  uv    ok"
else
  say "Installing uv (via Homebrew)"
  brew install uv
fi

# 2. Clone the Monarch bridge ------------------------------------------------
if [ -d "$MCP_DIR/.git" ]; then
  say "monarch-mcp-server already present at $MCP_DIR — skipping clone"
else
  say "Cloning monarch-mcp-server -> $MCP_DIR"
  mkdir -p "$(dirname "$MCP_DIR")"
  git clone "$MCP_REPO" "$MCP_DIR"
fi

# 3. Authenticate the bridge (interactive) -----------------------------------
say "Authenticating the Monarch bridge (interactive)"
echo "  This runs monarch-mcp-server's login_setup.py."
echo "  Session cookies from your browser are the most reliable option;"
echo "  email/password + TOTP also works. The session is stored in the macOS"
echo "  keychain. If macOS asks whether Python may access the keychain, click"
echo "  'Always Allow'."
printf "\n  Run the interactive login now? [Y/n] "
read ans
case "$ans" in
  [Nn]*) warn "Skipped. Run it later:  cd $MCP_DIR && uv run python login_setup.py" ;;
  *)     ( cd "$MCP_DIR" && uv run python login_setup.py ) ;;
esac

# Done — print the manual steps ----------------------------------------------
say "Scripted setup complete. Finish in the browser:"
cat <<EOF

  1. Load the extension:
       browser -> chrome://extensions  (Dia: dia://extensions)
       -> enable Developer mode -> Load unpacked -> select:
       $REPO_ROOT/extension

  2. Start the bridge at login:
       $REPO_ROOT/scripts/install-autostart.sh
     It listens on http://127.0.0.1:8642/mcp  (localhost only).

  3. Configure Settings (extension popup -> Settings):
       - paste your Claude API key  (https://console.anthropic.com)
       - Bank = Ally
       - Monarch connection = Local MCP server (default)
       - click "List tools (debug)" -> confirm a tool list comes back

  Full details: $REPO_ROOT/README.md
EOF
