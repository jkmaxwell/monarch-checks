👉 **PERSONAL PROJECT -- NOT ASSOCIATED WITH OR ENDORSED BY MONARCH MONEY** 👈

# Check Payee to Monarch

A browser extension that reads payees off Ally Bank check images and writes
them to the matching Monarch Money transactions.

Flow: capture check images from your Ally transaction page → crop the payee line
in-page → Claude vision reads the payee → review and correct in a table →
reconcile writes the merchant and category to each matching Monarch transaction.

It runs client-side. Full check images never leave the browser tab; only the
cropped payee strip is sent to the Claude API. Monarch writes go through an MCP
server you run locally.

## Requirements

- macOS. Tested there; Linux likely works, with keyring caveats.
- A Chromium browser: Dia, Chrome, Arc, Edge, or Brave.
- [Homebrew](https://brew.sh), `git`, and [`uv`](https://docs.astral.sh/uv/).
- An Ally Bank online-banking login.
- A [Monarch Money](https://www.monarchmoney.com) account.
- An [Anthropic API key](https://console.anthropic.com). Payee extraction costs
  a few cents per batch.

## Dependencies

- The extension has no dependencies: vanilla JavaScript, Manifest V3, no build
  step. It loads the Manrope font from Google Fonts; everything else is local.
- [robcerda/monarch-mcp-server](https://github.com/robcerda/monarch-mcp-server)
  (third-party) is the local bridge to Monarch. It uses your Monarch web
  session, so it sees Plaid-connected accounts that Monarch's official MCP hides
  (currently including Ally, which is why the bridge is the default). Its Python
  dependencies are managed by `uv`.
- The tools in `pipeline/`, `harness/`, and `src/` predate the extension and
  need Node 20+ and ImageMagick. Not required for normal use. See
  [docs/legacy-downloader.md](docs/legacy-downloader.md).

## Installation — one script

`setup.sh` does the scriptable parts (checks Homebrew and git, installs `uv`,
clones the Monarch bridge to `~/dev/monarch-mcp-server`, runs its interactive
login), then prints the browser steps it can't do:

```sh
git clone https://github.com/jkmaxwell/monarch-checks && cd monarch-checks
./setup.sh
```

It is safe to re-run; each step is skipped if already done. Then do steps 3–5
under Installation — manual.

## Installation — with Claude Code

Alternatively, clone this repo, `cd` into it, run `claude`, and paste:

> Set up this repo on my Mac per its README. Specifically: (1) check for and
> install missing dependencies — Homebrew, git, uv; (2) clone
> https://github.com/robcerda/monarch-mcp-server to ~/dev/monarch-mcp-server if
> it isn't already somewhere on disk; (3) walk me through its `login_setup.py`
> interactively so my Monarch session lands in the keychain; (4) start
> `scripts/monarch-mcp-http.sh` and verify http://127.0.0.1:8642/mcp answers an
> MCP initialize; (5) then walk me through loading `extension/` as an unpacked
> extension in my browser and configuring its Settings (Claude API key, Bank,
> Monarch connection = local MCP server → List tools to verify). Verify each
> step actually worked before moving on, and tell me exactly what to do for the
> steps you can't do yourself (keychain prompts, browser UI, logins).

## Installation — manual

1. Clone the repos.
   ```sh
   git clone https://github.com/jkmaxwell/monarch-checks && cd monarch-checks
   git clone https://github.com/robcerda/monarch-mcp-server ~/dev/monarch-mcp-server
   brew install uv   # if you don't have it
   ```
2. Authenticate the Monarch bridge (one-time).
   ```sh
   cd ~/dev/monarch-mcp-server && uv run python login_setup.py
   ```
   Session cookies from your browser are the most reliable option;
   email/password plus TOTP also works. The session is stored in the macOS
   keychain. If macOS later asks whether Python may access the keychain, click
   Always Allow.
3. Start the bridge (leave running while you use the extension).
   ```sh
   ./scripts/monarch-mcp-http.sh
   ```
   It defaults to `~/dev/monarch-mcp-server`; set `MONARCH_MCP_DIR` only if your
   checkout is elsewhere. It listens on `http://127.0.0.1:8642/mcp`, localhost
   only, no auth. Your Monarch credentials stay in the keychain.
4. Load the extension: browser → `chrome://extensions` (Dia:
   `dia://extensions`) → enable Developer mode → Load unpacked → select this
   repo's `extension/` directory.
5. Configure Settings (extension popup → Settings): paste your Claude API key;
   Bank = Ally; Monarch connection = Local MCP server (the default). Click List
   tools (debug) and confirm a tool list comes back.

## Usage

1. Log into Ally and open the account's transaction page (the one with
   `Check Paid #…` rows). Leave the tab open.
2. Extension popup → pick a history window → Capture. Ally serves check images
   slowly (about 1–2 min each) and throttles. The run stops cleanly when
   throttled; rerun later, and dedup means no rework.
3. Extract recipients: Claude reads each payee strip.
4. Review and correct: a table of strips with editable names and autocomplete.
5. Dry run (Monarch): plans every write, writes nothing. Review the log.
6. Reconcile to Monarch: assigns merchant and category to each matched
   transaction, verifying each write. Re-runs are idempotent.

Back up after each session (Settings → Export backup). Browsers can drop
unpacked extensions on updates (Dia has), which deletes all captured data.
Import backup restores it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Local MCP server unreachable" | The bridge isn't running — step 3 above |
| Reconcile flags "in Monarch, but its MCP hides Plaid-connected accounts" | You're on the official Monarch connection; switch Settings to the local bridge (or migrate the Ally connection off Plaid in Monarch) |
| `DCR failed: 403 … CSRF` connecting official Monarch | Fixed in current code (cookies are never sent); pull latest |
| Extension vanished from the browser | The browser dropped it on an update — reload unpacked, re-enter the API key, Import backup |
| Capture says "images not posted yet" | The check is too recent — it's skipped and retried next run |
| macOS keychain prompt when the bridge starts | Python reading the stored Monarch session — Always Allow |

## Security and privacy

- What leaves your machine: cropped payee strips to Anthropic's API;
  transaction queries and merchant/category writes to Monarch (via the local
  bridge or OAuth'd official MCP). Nothing else. Full check images never leave
  the browser tab.
- Where secrets live: Claude API key in the extension's local storage; Monarch
  session in the macOS keychain; official-mode OAuth tokens in extension
  storage. Nothing is committed to this repo; `downloads/`, `pipeline/out/`, and
  `.env` are gitignored.

## Repository layout

- `extension/` — the extension ([architecture notes](extension/README.md))
- `scripts/monarch-mcp-http.sh` — serves the Monarch bridge over HTTP
- `setup.sh` — scripted setup
- `TODO.md` — multi-bank support and its requirements
- `pipeline/`, `harness/`, `src/` — legacy pre-extension tools
  ([docs](docs/legacy-downloader.md))
- `docs/superpowers/` — design specs and plans
