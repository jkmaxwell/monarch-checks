# Check Payee to Monarch

A browser extension that turns paper checks into clean Monarch Money data:

**Ally Bank** → capture check images in-page → crop the payee line → **Claude
vision** reads the payee → you review/correct in a table → **Monarch Money**
gets the merchant + category written to the matching transaction.

Everything runs client-side: check images never leave the browser tab (only the
small cropped payee strip is sent to the Claude API), and Monarch writes go
through an MCP server you run locally.

## Requirements

| What | Why |
|---|---|
| macOS (tested; Linux likely works with keyring caveats) | The Monarch bridge stores its session in the system keychain |
| A Chromium browser (Dia, Chrome, Arc, Edge, Brave) | The extension loads unpacked via Developer mode |
| [Homebrew](https://brew.sh), `git`, [`uv`](https://docs.astral.sh/uv/) | To run the local Monarch MCP bridge |
| An Ally Bank online-banking login | Checks are captured from your logged-in transaction page |
| A [Monarch Money](https://www.monarchmoney.com) account | Where reconciled merchants/categories are written |
| An [Anthropic API key](https://console.anthropic.com) | Payee extraction (Claude vision); costs pennies per batch |

## Dependencies

- **The extension itself has none** — vanilla JavaScript, Manifest V3, no build
  step. (It loads the Manrope font from Google Fonts; everything else is local.)
- **[robcerda/monarch-mcp-server](https://github.com/robcerda/monarch-mcp-server)**
  (third-party) — the local bridge to Monarch. It uses your Monarch web session,
  so it can see Plaid-connected accounts that Monarch's official MCP hides
  (which currently includes Ally — this is why the bridge is the default).
  Python dependencies are managed by `uv` automatically.
- *Optional legacy tools* (`pipeline/`, `harness/`, `src/`) predate the
  extension and need Node 20+ and ImageMagick — **not required** for normal
  use. See [docs/legacy-downloader.md](docs/legacy-downloader.md).

## Installation — let Claude Code do it

Since you'll need a Claude API key anyway, the fastest path is Claude Code.
Clone this repo, `cd` into it, run `claude`, and paste:

> Set up this repo on my Mac per its README. Specifically: (1) check for and
> install missing dependencies — Homebrew, git, uv; (2) clone
> https://github.com/robcerda/monarch-mcp-server to ~/dev/monarch-mcp-server if
> it isn't already somewhere on disk; (3) walk me through its `login_setup.py`
> interactively so my Monarch session lands in the keychain; (4) start
> `scripts/monarch-mcp-http.sh` with MONARCH_MCP_DIR pointing at that checkout
> and verify http://127.0.0.1:8642/mcp answers an MCP initialize; (5) then walk
> me through loading `extension/` as an unpacked extension in my browser and
> configuring its Settings (Claude API key, Bank, Monarch connection = local
> MCP server → List tools to verify). Verify each step actually worked before
> moving on, and tell me exactly what to do for the steps you can't do yourself
> (keychain prompts, browser UI, logins).

## Installation — manual

1. **Clone the repos**
   ```sh
   git clone https://github.com/jkmaxwell/monarch-checks && cd monarch-checks
   git clone https://github.com/robcerda/monarch-mcp-server ~/dev/monarch-mcp-server
   brew install uv   # if you don't have it
   ```
2. **Authenticate the Monarch bridge** (one-time)
   ```sh
   cd ~/dev/monarch-mcp-server && uv run python login_setup.py
   ```
   Session cookies from your browser are the most reliable option;
   email/password + TOTP also works. The session is stored in the macOS
   keychain. If macOS asks whether Python may access the keychain later, click
   **Always Allow**.
3. **Start the bridge** (leave running while you use the extension)
   ```sh
   MONARCH_MCP_DIR=~/dev/monarch-mcp-server ./scripts/monarch-mcp-http.sh
   ```
   It listens on `http://127.0.0.1:8642/mcp` (localhost only, no auth — your
   Monarch credentials never leave the keychain).
4. **Load the extension**: browser → `chrome://extensions` (Dia:
   `dia://extensions`) → enable **Developer mode** → **Load unpacked** → select
   this repo's `extension/` directory.
5. **Configure Settings** (extension popup → Settings): paste your Claude API
   key; Bank = Ally; Monarch connection = **Local MCP server** (the default) —
   click **List tools (debug)** and confirm a tool list comes back.

## Usage

1. Log into Ally and open the account's transaction page (the one with
   `Check Paid #…` rows). Leave the tab open.
2. Extension popup → pick a history window → **Capture**. Ally serves check
   images slowly (~1–2 min each) and throttles; the run stops cleanly when
   throttled — rerun later, dedup means no rework.
3. **Extract recipients** — Claude reads each payee strip.
4. **Review & correct** — table of strips with editable names + autocomplete.
5. **Dry run (Monarch)** — plans every write, writes nothing. Review the log.
6. **Reconcile to Monarch** — assigns merchant + category to each matched
   transaction, verifying each write. Re-runs are idempotent.

**Back up after each session** (Settings → *Export backup*): browsers can drop
unpacked extensions on updates (Dia has), which deletes all captured data.
*Import backup* restores everything.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Local MCP server unreachable" | The bridge isn't running — step 3 above |
| Reconcile flags "in Monarch, but its MCP hides Plaid-connected accounts" | You're on the **official** Monarch connection; switch Settings to the local bridge (or migrate the Ally connection off Plaid in Monarch) |
| `DCR failed: 403 … CSRF` connecting official Monarch | Fixed in current code (cookies are never sent); pull latest |
| Extension vanished from the browser | The browser dropped it on an update — reload unpacked, re-enter the API key, *Import backup* |
| Capture says "images not posted yet" | The check is too recent — it's skipped and retried next run |
| macOS keychain prompt when the bridge starts | Python reading the stored Monarch session — **Always Allow** |

## Security & privacy

- **What leaves your machine:** cropped payee strips → Anthropic's API;
  transaction queries and merchant/category writes → Monarch (via the local
  bridge or OAuth'd official MCP). Nothing else. Full check images never leave
  the browser tab.
- **Where secrets live:** Claude API key in the extension's local storage;
  Monarch session in the macOS keychain; official-mode OAuth tokens in
  extension storage. Nothing is committed to this repo — `downloads/`,
  `pipeline/out/`, and `.env` are gitignored.

## Repository layout

- `extension/` — the product ([architecture notes](extension/README.md))
- `scripts/monarch-mcp-http.sh` — serves the Monarch bridge over HTTP
- `TODO.md` — roadmap (multi-bank support and its requirements)
- `pipeline/`, `harness/`, `src/` — legacy pre-extension tools
  ([docs](docs/legacy-downloader.md))
- `docs/superpowers/` — design specs and plans
