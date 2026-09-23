#!/bin/sh
# Serve robcerda/monarch-mcp-server over streamable HTTP for the Ally Checks
# extension (its default is stdio, which a browser extension can't speak).
#
#   ALLY_CHECKS_EXTENSION_ID=<id> scripts/monarch-mcp-http.sh [port]
#
# ALLY_CHECKS_EXTENSION_ID is the extension's ID from chrome://extensions
# (Dia: dia://extensions). The server rejects browser Origins it doesn't know
# (HTTP 400), so without it the extension can't connect.
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
if [ -n "$ALLY_CHECKS_EXTENSION_ID" ]; then
  set -- --allowed-origin "chrome-extension://$ALLY_CHECKS_EXTENSION_ID"
else
  echo "warning: ALLY_CHECKS_EXTENSION_ID not set — the extension's requests will be rejected (400)" >&2
  set --
fi
exec uv run --directory "$DIR" --locked monarch-mcp-server \
  --transport http --host 127.0.0.1 --port "$PORT" "$@"
