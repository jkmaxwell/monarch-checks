#!/bin/sh
# Serve robcerda/monarch-mcp-server over streamable HTTP for the Ally Checks
# extension (its default is stdio, which a browser extension can't speak).
#
#   scripts/monarch-mcp-http.sh [port]
#
# MONARCH_MCP_DIR defaults to ~/dev/monarch-mcp-server (where the README tells
# you to clone it); set it only if your checkout lives elsewhere:
#   MONARCH_MCP_DIR=~/path/to/monarch-mcp-server scripts/monarch-mcp-http.sh [port]
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
exec uv run --directory "$DIR" python -c "
from monarch_mcp_server.app import mcp
mcp.settings.host = '127.0.0.1'
mcp.settings.port = $PORT
mcp.run(transport='streamable-http')
"
