# Ally Checks — M4 Data Pipeline Design

**Date:** 2026-06-07
**Status:** Approved design, pre-implementation
**Scope:** Turn the downloaded check images (v1 output) into a **verified dataset**
of `{date, check number, amount, recipient}` in CSV + JSON. Monarch
reconciliation is explicitly deferred (assume it works downstream); the dataset
is built to be reconciliation-ready.

**Predecessor:** v1 (the Ally check downloader) is complete and merged. It
produces `downloads/` containing front/back JPEGs named
`{date}_check-{number}_{amount}_{side}.jpg` and an `ally-checks-metadata.json`
array of records (`checkNumber`, `amount`, `date`, `postedDateTime`,
`description`, `type`, `frontFile`, `backFile`, `recipient: null`).

**Parent spec:** `2026-06-07-ally-checks-downloader-design.md` (see its "Reframed
end goal" and "M4 (the data pipeline)" sections).

## Goal

The deliverable is **data, not images**. Date, check number, and amount are
already structured data captured from Ally's page text. The only field requiring
the image is the **recipient** (the handwritten/typed "Pay to the order of"
line). M4 reads that, lets the user verify it, emits a clean dataset, and deletes
the images.

```
crop payee strip → vision-extract recipient → user verifies → emit CSV+JSON → delete images
```

## Privacy posture (decided)

Recipient extraction uses **cloud vision (Claude API)** on a **locally-cropped
payee strip only** — the signature, account/routing MICR line, and payer address
never leave the machine. Basis: the commercial Anthropic API does not train on
inputs by default and retains them only briefly for trust & safety; cropping
minimizes what is exposed. A **fully-local extraction backend** (on-device OCR or
crop-and-type) is a future option; the extraction step is designed as a swappable
backend to allow it.

## Validated facts

- **Crop region:** `magick <front>.jpg -crop 780x95+80+150 +repage <strip>.png`
  isolates the payee line on Ally's 1176×512 front image. Confirmed against
  checks #1769 and #1776: captures the payee name, excludes signature /
  account / routing / payer address.
- **Vision read:** handwritten cursive payee names read accurately from the strip
  (validated by reading the crops directly).

## Pipeline

A standalone Node pipeline in `pipeline/`, run on the `downloads/` artifacts.

### Stage 1 — Crop (in `build-review.js`)

For each record in `ally-checks-metadata.json`, crop the payee strip from its
`frontFile` using the validated coordinates into a temp dir
(`pipeline/strips/{checkNumber}_payee.png`). Shell out to ImageMagick (`magick`).

### Stage 2 — Extract (in `build-review.js`)

For each strip, call the Claude vision API:

- Model: `claude-opus-4-8`.
- Input: the strip as a base64 `image` block + an instruction.
- **Structured output** via `output_config.format` (json_schema,
  `additionalProperties: false`) returning:
  ```json
  { "recipient": "string", "confidence": "high" | "medium" | "low" }
  ```
- Prompt (concise): "This image is the 'Pay to the order of' line cropped from a
  paper check. Return the payee name exactly as written. If you cannot read it,
  return an empty recipient and confidence 'low'."
- Auth: `ANTHROPIC_API_KEY` from the environment (the official `@anthropic-ai/sdk`
  reads it automatically). If unset, fail fast with a clear message.
- Resilience: per-strip try/catch; a failed extraction yields
  `{recipient: "", confidence: "low"}` and is flagged for review rather than
  aborting the run.

### Stage 3 — Review (self-contained HTML)

`build-review.js` writes `pipeline/out/review.html` — a **single self-contained
file** (no server). For each check it embeds:

- the payee strip as a data URI (so the file is portable and works offline),
- an **editable text input** pre-filled with the extracted recipient,
- check number, amount, date (read-only),
- a confidence indicator; rows with `confidence != high` or empty recipient are
  visually flagged ("needs review").

A header **"Export verified"** button builds `ally-checks-verified.csv` and
`ally-checks-verified.json` client-side from the current input values (via `Blob`
+ download) — no network, no server. The user corrects recipients inline, then
exports.

`build-review.js` also writes a preliminary `pipeline/out/checks.prelim.json`
(pre-verification snapshot) for audit.

### Stage 4 — Cleanup (in `cleanup.js`)

A separate, deliberate step (so images are never deleted before verification).
Deletes the raw check images and cropped strips, preserving the dataset:

- removes `downloads/*.jpg` (and `*.png`) and `pipeline/strips/`,
- leaves `pipeline/out/` and any exported verified files untouched,
- requires an explicit confirmation flag (e.g. `node pipeline/cleanup.js
  --confirm`) and prints what it will delete first.

## Data schemas

**Verified JSON** (array; one object per check):
```json
{
  "checkNumber": "1769",
  "date": "2026-06-02",
  "amount": "250.00",
  "recipient": "Jane Doe",
  "confidence": "high",
  "postedDateTime": "Jun 2, 2026 11:12 pm ET",
  "description": "Check Paid #1769",
  "type": "Withdrawal"
}
```

**Verified CSV** columns (Monarch-friendly, one row per check):
`date,check_number,amount,recipient,confidence`

The match keys for future Monarch reconciliation (`check_number`, `amount`,
`date`) are all present.

## File structure

- `pipeline/build-review.js` — crop + extract + emit `review.html` + prelim JSON.
- `pipeline/cleanup.js` — delete images/strips after verification (`--confirm`).
- `pipeline/lib/crop.js` — payee-strip crop helper (ImageMagick wrapper).
- `pipeline/lib/extract.js` — Claude API recipient extraction (swappable backend
  boundary; a future local backend implements the same interface).
- `pipeline/lib/review-html.js` — builds the self-contained review page.
- `pipeline/package.json` — depends on `@anthropic-ai/sdk`.
- `pipeline/out/` — generated `review.html`, `checks.prelim.json` (gitignored).
- `pipeline/strips/` — temp crops (gitignored).

## Dependencies

- **ImageMagick** (`magick`) — present at `/opt/homebrew/bin/magick`.
- **`@anthropic-ai/sdk`** — npm, installed under `pipeline/`.
- **`ANTHROPIC_API_KEY`** — supplied in the environment at run time (user-provided).

## Testing

Build-first, consistent with v1 — no formal unit suite. Verification:

- **Pure helpers** (crop-arg builder, CSV row builder) written as small standalone
  functions; a quick Node sanity check on the CSV builder.
- **Extraction smoke test:** one real API call on one cropped strip (e.g. #1769),
  confirm it returns `recipient: "Jane Doe"` with high confidence, before
  running the batch. (Requires `ANTHROPIC_API_KEY`.)
- **Review page:** open `review.html`, confirm strips render, recipients are
  editable, flagged rows are obvious, and "Export verified" downloads correct
  CSV + JSON.
- **Cleanup:** dry-run output lists the right files; `--confirm` removes images
  and strips while leaving the dataset.

## Out of scope (future)

- **Monarch reconciliation** — matching each verified check to its Monarch
  transaction and enriching the payee via the Monarch MCP (Claude-driven). The
  dataset here is the staging artifact for it.
- **Fully-local extraction backend** — on-device OCR or crop-and-type, behind the
  same `extract.js` interface.
- **In-browser productization** — folding download + review into a single
  in-browser product surface (relates to the M3 extension).
