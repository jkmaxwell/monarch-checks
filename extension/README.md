# Check Payee to Monarch — browser extension

> Fresh install? The [top-level README](../README.md) has the full
> requirements/installation guide (including a Claude Code setup prompt).
> This file covers the extension itself in more depth.

Captures check images from Ally, crops the payee line in-page, extracts the
recipient with Claude vision, lets you review/correct, and reconciles the
results into Monarch via the official Monarch MCP. Entirely client-side.

## Installing (Dia / any Chromium browser)

This extension is never packaged or published — it only runs as an **unpacked
extension in developer mode**:

1. Make sure you're in the right profile (in Dia: the **1-Personal** space —
   that's where 1Password, Tampermonkey, etc. live).
2. Open `dia://extensions` (or `chrome://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this `extension/` directory.
5. Open the extension's **Settings** (from the popup) and:
   - paste your Claude API key,
   - pick a **Monarch connection** (see below).

## Monarch connection modes

**Local MCP server (default, recommended).** Monarch's official MCP stopped
returning transactions from Plaid-connected accounts — which includes Ally —
so reconcile can't see any checks through it. The workaround is
[robcerda/monarch-mcp-server](https://github.com/robcerda/monarch-mcp-server),
which uses your Monarch web session and sees every account:

1. Clone it and run its `login_setup.py` once (stores a session in the keyring).
2. Serve it over HTTP for the extension:
   `MONARCH_MCP_DIR=~/path/to/monarch-mcp-server scripts/monarch-mcp-http.sh`
   (listens on `http://127.0.0.1:8642/mcp`; keep it running during reconcile).
3. In Settings, keep mode on **Local MCP server**; "List tools (debug)" should
   return its tool list.

In this mode merchants are assigned by name (`update_transaction`), Monarch
links-or-creates them server-side, and the duplicate-merge sweep is skipped
(name assignment can't create duplicates).

**Official Monarch MCP (OAuth).** Click **Connect Monarch** and approve the
consent screen. Full merchant tooling (search/create/merge), but Plaid-connected
accounts are invisible to it — only useful if/when the Ally connection is
migrated off Plaid (`app.monarchmoney.com/accounts?reconnect=plaid_migration`).

> ⚠️ **Dia can silently remove unpacked extensions on updates** — and Chromium
> deletes an extension's `chrome.storage` and IndexedDB when it's removed, which
> wipes every captured check and extracted recipient. This happened once already
> (July 2026, Dia 1.39). Two habits protect you:
>
> 1. **Export a backup after each session** — Settings → *Export backup*. The
>    JSON lands in `~/Downloads` and can be re-imported after a reinstall.
> 2. If the toolbar icon disappears, don't panic: reload unpacked (steps above),
>    re-paste the API key, reconnect Monarch, and *Import backup*.

## Usage

1. Log into Ally and open the account's transaction list (the page with
   `Check Paid #…` rows). Leave that tab open.
2. Click the extension icon → **Capture new checks**. It walks the list, opens
   each new check, and streams metadata + a cropped payee strip to storage.
   Ally is slow (~1–2 min per check) and throttles aggressively — the run stops
   itself cleanly when it detects throttling; just rerun later (dedup means no
   rework).
3. **Extract recipients** — reads each payee strip with Claude. Stops after 3
   consecutive API errors (bad key / rate limit) rather than junking the backlog.
4. **Review & correct** — table of strips with editable recipient fields and
   autocomplete.
5. In Settings, use **Probe a check** (read-only) to sanity-check Monarch, then
   from the popup run reconcile as a **dry run** first; it plans matches,
   merchant creation, and category derivation without writing anything.

## Layout

- `background/service-worker.js` — message router, run orchestration, backup
  export/import.
- `background/anthropic.js` — Claude vision call (recipient from payee strip).
- `background/mcp-client.js` + `monarch.js` — Monarch MCP (OAuth 2.1 PKCE +
  Streamable HTTP) and high-level ops.
- `background/reconcile.js` — the procedure-spec engine (tiered match,
  idempotent assign, category derive, duplicate-merchant merge, dry-run).
- `content/ally-capture.js` — self-contained Ally DOM walker + in-page crop
  (full check images never leave the tab).
- `dashboard/`, `review/`, `options/` — UI pages.
- `lib/` — storage, IndexedDB (payee strips), pure helpers.
