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
> interactively so my Monarch session lands in the keychain; (4) walk me
> through loading `extension/` as an unpacked extension in my browser; (5) run
> `scripts/install-autostart.sh` and verify http://127.0.0.1:8642/mcp answers
> an MCP initialize sent with the extension's Origin
> (chrome-extension://efchglphphlccjofdnfjopohdmgdlopd); (6) then walk me through configuring its Settings
> (Claude API key, Bank, Monarch connection = local MCP server → List tools to verify). Verify each
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
3. Load the extension: browser → `chrome://extensions` (Dia:
   `dia://extensions`) → enable Developer mode → Load unpacked → select this
   repo's `extension/` directory. Its ID is always `efchglphphlccjofdnfjopohdmgdlopd`
   (pinned by the `key` in `manifest.json`), so the bridge already allows it.
4. Start the bridge at login:
   ```sh
   ./scripts/install-autostart.sh
   ```
   This installs a LaunchAgent that runs `scripts/monarch-mcp-http.sh` (the
   server's own `--transport http` mode) at login and restarts it if it exits;
   `--uninstall` removes it. To run it once in a terminal instead:
   `./scripts/monarch-mcp-http.sh`. If you changed the extension and its ID
   differs, pass `ALLY_CHECKS_EXTENSION_ID=<id>` to either script.

   It defaults to `~/dev/monarch-mcp-server`; set `MONARCH_MCP_DIR` only if your
   checkout is elsewhere. It listens on `http://127.0.0.1:8642/mcp`, localhost
   only, no auth. Your Monarch credentials stay in the keychain. After
   re-running `login_setup.py`, restart it so it picks up the new session:
   `launchctl kickstart -k gui/$(id -u)/com.monarch-checks.mcp-http`.
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
| "Local MCP server unreachable" | The bridge isn't running — step 4 above |
| `MCP initialize HTTP 400 … Invalid Origin` | The bridge doesn't know this extension's ID — the extensions page should show `efchglphphlccjofdnfjopohdmgdlopd`; if it doesn't, the manifest `key` was changed; re-run step 4 with `ALLY_CHECKS_EXTENSION_ID=<id>` |
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
- `scripts/install-autostart.sh` — runs the bridge as a login LaunchAgent
- `setup.sh` — scripted setup
- `TODO.md` — multi-bank support and its requirements
- `pipeline/`, `harness/`, `src/` — legacy pre-extension tools
  ([docs](docs/legacy-downloader.md))
- `docs/superpowers/` — design specs and plans
