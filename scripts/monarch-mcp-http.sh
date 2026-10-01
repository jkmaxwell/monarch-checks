#!/bin/sh
# Serve robcerda/monarch-mcp-server over streamable HTTP for the Check Payee
# to Monarch extension (its default is stdio, which a browser extension can't speak).
#
#   scripts/monarch-mcp-http.sh [port]
#
# The server rejects browser Origins it doesn't know (HTTP 400). The extension's
# ID is pinned by the "key" in extension/manifest.json, so it is the same on
# every install and is allowed by default. Set MONARCH_CHECKS_EXTENSION_ID only if
# you load a modified extension that has a different ID (chrome://extensions,
# Dia: dia://extensions).
#
# MONARCH_MCP_DIR defaults to ~/dev/monarch-mcp-server (where the README tells
# you to clone it); set it only if your checkout lives elsewhere.
#
# Endpoint: http://127.0.0.1:<port>/mcp   (default port 8642 — matches the
# extension's default; change both together). Auth to Monarch comes from the
# server's own keyring session — run its login_setup.py once first.
set -e
DIR="${MONARCH_MCP_DIR:-$HOME/dev/monarch-mcp-server}"
if [ ! -d "$DIR" ]; then
  echo "monarch-mcp-server not found at $DIR" >&2
  echo "Clone it there, or set MONARCH_MCP_DIR to your checkout." >&2
  exit 1
fi
PORT="${1:-8642}"
EXT_ID="${MONARCH_CHECKS_EXTENSION_ID:-efchglphphlccjofdnfjopohdmgdlopd}"  # pinned by extension/manifest.json "key"
set -- --allowed-origin "chrome-extension://$EXT_ID"
exec uv run --directory "$DIR" --locked monarch-mcp-server \
  --transport http --host 127.0.0.1 --port "$PORT" "$@"
