# Ally Checks Downloader — Design (v1)

**Date:** 2026-06-07
**Status:** Approved design, pre-implementation
**Scope of this spec:** Milestone 1 only (the v1 console snippet). Later milestones are described in the Roadmap for context but are **not** part of this spec.

## Goal

Download front and back check images from Ally Bank's website at full
resolution, with descriptive filenames, and capture the associated transaction
metadata. The long-term goal is to analyze checks for **date, check number,
recipient, and amount**; this spec delivers the first concrete step toward that.

Automated bank login is explicitly out of scope and impossible — the user is
already logged in, and all work happens inside that authenticated browser
session.

## Key facts established from the live DOM

These were confirmed against real Ally page markup and drive the design:

1. **Check images are same-origin `blob:` URLs.** The rendered images are
   `<img>` elements:
   - Front: `img[data-testid="frontCheckImage"]`, `src="blob:https://secure.ally.com/..."`
   - Back: `img[data-testid="backCheckImage"]`, `src="blob:https://secure.ally.com/..."`

   Because they are same-origin blobs, a script in the page can `fetch()` them
   and save the original bytes — no screenshotting, full resolution.

2. **Most metadata is already on the page as text** — no OCR required for it.
   In the **Transaction details** modal (`[data-testid="transaction-detail-modal"]`),
   labeled rows expose:
   - `Check Number:` → e.g. `1776`
   - `Amount:` → e.g. `−$250.00` (note: Unicode minus `−` U+2212, not ASCII `-`)
   - `Posted:` → e.g. `Jun 2, 2026 11:12 pm ET`
   - `Description:` → e.g. `Check Paid #1776`
   - `Type:` → e.g. `Withdrawal`

3. **Recipient is the only field requiring OCR.** Ally's "Description" is just
   `Check Paid #<n>`; the actual payee appears only on the check image itself.
   Recipient OCR is deferred to a later milestone.

4. **Class names are unreliable; `data-testid` is stable.** Styled-components
   produces randomized class names (e.g. `hhQOAA`). The design targets
   `data-testid` attributes and bold heading label text, never classes.

5. **The transaction list paginates** via a "View More" button:
   `button[data-testid="viewMoreButton"]`. The walker must click it to load
   additional history.

## v1 behavior: bounded batch walker

A console snippet the user pastes into Ally's DevTools while viewing a transaction
list. It walks check transactions, downloads images, and emits one aggregated
metadata file per run. The single-check download mechanics ("Approach 2") are the
inner loop.

### Configuration (top of snippet)

```js
const MAX_CHECKS  = 25;   // primary bound: max checks to download this run
const START_INDEX = 0;    // skip this many checks from the top (manual paging)
const MAX_PAGES   = 20;   // safety cap on "View More" clicks
const CHECK_TIMEOUT_MS = 180000; // 3 min per-check wait for images to load
const BETWEEN_CHECKS_MS = 1500;  // polite delay between checks
```

**Control model (Option B):** count limit + start offset. The list is
newest-first and order is stable, so the user backfills by re-running with an
advancing `START_INDEX` (e.g. `0,25` → `25,50` → `50,75`). No persistence in v1;
real cross-run tracking is deferred to the M3 extension.

### The loop

1. **Enumerate** check rows currently loaded in the list: list items whose
   description (`[data-testid="transaction-history-desc"]` text) matches
   `/Check Paid #(\d+)/`.
2. Skip the first `START_INDEX` checks.
3. For each subsequent check, until `MAX_CHECKS` downloaded:
   1. Click the row → **Transaction details** modal opens.
   2. **Read metadata** from the modal by matching bold heading labels
      (`Check Number:`, `Amount:`, `Posted:`, `Description:`, `Type:`).
   3. **Expand images:** click the `View check images` accordion button only if
      `aria-expanded="false"`.
   4. **Poll** until both `img[data-testid="frontCheckImage"]` and
      `backCheckImage` exist and are fully loaded (`complete && naturalWidth > 0`),
      every ~1s, up to `CHECK_TIMEOUT_MS`, printing a "still loading…" heartbeat.
   5. **Download** each image: `fetch(blobURL)` → `blob` → derive extension from
      `blob.type` (`image/png`→`.png`, `image/jpeg`→`.jpg`, fallback `.png`) →
      trigger a download via a temporary `<a download>`; revoke the object URL.
   6. **Record** the metadata in an in-memory array.
   7. **Close** the modal (Escape first, close-button fallback — see Unknowns),
      return to the list; wait `BETWEEN_CHECKS_MS`.
4. When the loaded list is exhausted but `MAX_CHECKS` is not reached, click
   `viewMoreButton`, wait for new rows to appear, and continue — up to `MAX_PAGES`.
5. **At end of run:** print `console.table` of all records and download one
   aggregated `ally-checks-metadata.json`.

### Filenames

Pattern: `{date}_check-{number}_{amount}_{side}.{ext}`

Example: `2026-06-02_check-1776_250.00_front.png` (and `_back.png`).

- `date`: `Posted` parsed to `YYYY-MM-DD` (`Jun 2, 2026 ...` → `2026-06-02`).
- `amount`: absolute value, `$` and Unicode minus stripped → `250.00`.
- All components sanitized for filesystem safety.

### Metadata record (per check)

```json
{
  "checkNumber": "1776",
  "amount": "250.00",
  "date": "2026-06-02",
  "postedDateTime": "Jun 2, 2026 11:12 pm ET",
  "description": "Check Paid #1776",
  "type": "Withdrawal",
  "frontFile": "2026-06-02_check-1776_250.00_front.png",
  "backFile": "2026-06-02_check-1776_250.00_back.png",
  "recipient": null
}
```

`recipient` is always `null` in v1 (filled by OCR in a later milestone).

### Stop conditions

The run ends when any of these is true:

- `MAX_CHECKS` checks downloaded, or
- no more check rows and no "View More" button, or
- `MAX_PAGES` "View More" clicks reached.

A single check whose images never load within `CHECK_TIMEOUT_MS` is **logged and
skipped** — it does not abort the run.

### Error handling

- **No transaction list present** → alert and stop.
- **Images time out for a check** → log which check, skip, continue.
- **Blob fetch fails** → report which side (front/back) failed for which check so
  it can be retried; continue.
- **Browser "allow multiple downloads" prompt** is expected on first run; user
  approves once.

## Testing

For v1 the priority is simply getting a working snippet — **no formal unit-test
suite**. Verification is manual against the live page:

- Run on a known check (e.g. #1776) with `MAX_CHECKS=1`; confirm two
  correctly-named full-resolution images land in Downloads and the metadata table
  is accurate.
- Then a small batch (`MAX_CHECKS=3`) including one "View More" pagination,
  confirming the aggregated JSON.

(Parsing helpers like `parseAmount`/`parseDate`/`buildFilename` will still be
written as small standalone functions so they're easy to test later if desired —
but writing those tests is deferred.)

## Unknowns to confirm during implementation

- **Modal close mechanism.** The close control was not in the captured HTML.
  Plan: send `Escape` first; fall back to a close button (likely an
  `aria-label="Close"` or a `data-testid`). Confirm against the live page. Not a
  blocker for this spec.

## Reframed end goal: data, not images

Confirmed direction (2026-06-07): **the deliverable is structured data, not a
folder of images.** Images are an intermediate artifact. The full pipeline:

```
download image → extract every field we can → user verifies the gaps → emit clean data → delete images
```

Date, check number, and amount are already structured data from the page text
(no OCR). The **recipient** is the only field that requires reading the image —
so "analyze the image" reduces to "read the payee line."

## Roadmap (not in this spec)

- **M2:** wrap the working snippet as a one-click bookmarklet.
- **M3:** full Chrome extension — per-check Download button, batch walker with
  **persistent cross-run tracking** (localStorage/IndexedDB, true resume/dedup),
  accumulating metadata file (CSV/JSON), settings UI.
- **M4 (the data pipeline):** extract the **recipient** and emit a clean dataset.
  - **Recipient extraction (decided): cloud vision (Claude API) on a
    locally-cropped payee strip.** Crop just the "Pay to the order of" band from
    the check-front image locally and send only that strip to the vision API —
    the signature, account number, and MICR routing line never leave the machine.
    Privacy basis: the commercial Anthropic API does not train on inputs by
    default and retains them only briefly for trust & safety; cropping minimizes
    what is exposed in that window. Use model `claude-opus-4-8` (vision) unless a
    cheaper tier proves sufficient.
  - **Future: support a fully-local mode** (on-device OCR such as Tesseract, or
    crop-and-manually-type) so nothing leaves the machine at all, for users who
    won't send any check imagery to a third party. Deferred, but the recipient-
    extraction step should be designed as a swappable backend to allow it.
  - **Verification:** surface low-confidence / missing fields for the user to
    confirm or correct before the data is finalized (UX TBD — CLI prompts, an
    HTML review page, or an editable CSV).
  - **Cleanup:** once data is finalized and verified, delete the downloaded
    images (optionally keep an archive). End state on disk is the dataset.
  - **Cross-check:** optionally verify the vision-read amount/check number
    against the page text already captured.
  - **Validated crop region (2026-06-07):** on Ally's 1176×512 check-front
    image, `magick <front> -crop 780x95+80+150 +repage <strip>` isolates the
    "Pay to the order of" line. Confirmed against checks #1769 and #1776: the
    strip captures the payee name and excludes the payer address (top), the
    signature, and the MICR routing/account line (bottom). Handwritten cursive
    read accurately via vision. Coordinates assume the consistent Ally layout;
    re-confirm if Ally changes image dimensions.
  - Open design questions for the M4 spec: verification UX, final output format
    (CSV/JSON), image-retention policy, and `ANTHROPIC_API_KEY` handling for the
    standalone pipeline.
