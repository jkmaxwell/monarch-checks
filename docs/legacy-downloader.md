# Ally Checks Downloader
A browser console snippet that downloads front/back check images from Ally Bank
at full resolution and captures their metadata.

## Usage

1. Log into Ally and open the account's **transaction list** (the page with
   `Check Paid #...` rows).
2. Open DevTools (Cmd+Option+I) → **Console**.
3. Paste the entire contents of `src/ally-checks.js` and press Enter.
   Pasting does nothing on its own.
4. Start a run:
   ```js
   await allyChecks.run()                       // default: up to 25 checks
   await allyChecks.run({ MAX_CHECKS: 1 })       // just one (good for a first test)
   await allyChecks.run({ MAX_CHECKS: 25, START_INDEX: 25 }) // next page of a backfill
   ```
5. Approve the browser's "allow multiple downloads" prompt the first time.

Each check takes ~1–2 minutes to load on Ally's side, so a full run is slow —
leave the tab focused and let it work. Images land in your Downloads folder, named
like `2026-06-02_check-1776_250.00_front.png`, plus an `ally-checks-metadata.json`
summary at the end.

## Options (`run({...})`)

| Option | Default | Meaning |
| --- | --- | --- |
| `MAX_CHECKS` | 25 | Max checks to download this run |
| `START_INDEX` | 0 | Skip this many checks from the top (manual paging across runs) |
| `MAX_PAGES` | 20 | Safety cap on "View More" clicks |
| `CHECK_TIMEOUT_MS` | 180000 | Per-check wait for images to load |
| `BETWEEN_CHECKS_MS` | 1500 | Delay between checks |

## Backfilling

There is no cross-run memory yet (planned for the extension version). To work
through a large history, advance `START_INDEX` each run:
`run({MAX_CHECKS:25, START_INDEX:0})`, then `25`, then `50`, …

## Not yet built

- `recipient` is always `null` — it's the only field not on the page as text and
  needs OCR of the check image (planned).
- One-click bookmarklet and a full Chrome extension with persistent tracking.
