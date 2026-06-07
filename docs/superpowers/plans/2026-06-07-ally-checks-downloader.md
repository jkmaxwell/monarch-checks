# Ally Checks Downloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser console snippet that downloads front/back check images from Ally Bank at full resolution and captures their metadata, walking the transaction list with bounded pagination.

**Architecture:** A single JavaScript file (`src/ally-checks.js`) pasted into Ally's DevTools console. It defines `window.allyChecks` (helpers + a `run()` entry point) and does **not** auto-execute on paste. `run()` is a bounded batch walker: it enumerates `Check Paid #<n>` rows, opens each, reads metadata from the detail modal, expands and waits for the on-demand blob images, downloads them with descriptive filenames, closes the modal, paginates via "View More", and finally emits one aggregated metadata JSON.

**Tech Stack:** Vanilla browser JavaScript (no build step, no dependencies). Targets stable `data-testid` attributes and bold heading label text — never the randomized styled-components class names.

**Verification note:** Per the spec, v1 is build-first with **no formal unit-test suite**. Pure parsers get a quick Node sanity check; everything DOM-related is verified manually against the live, logged-in Ally page. Tasks that need the live page say so explicitly.

**Reference spec:** `docs/superpowers/specs/2026-06-07-ally-checks-downloader-design.md`

---

## File Structure

- **Create:** `src/ally-checks.js` — the entire console snippet. Built up across all tasks. Sections, in file order:
  1. Config constants
  2. Pure helpers: `parseAmount`, `parseDate`, `sanitize`, `buildFilename`
  3. Small async/DOM utilities: `sleep`, `getFieldByLabel`
  4. Metadata: `readModalMetadata`
  5. Per-check image flow: `expandAndWaitForImages`, `downloadSide`
  6. List/navigation: `findCheckRows`, `openRow`, `closeModal`, `clickViewMore`
  7. Aggregation: `downloadJson`
  8. Walker: `run`
  9. Exposure: `window.allyChecks = { ... }`
- **Create:** `README.md` — how to paste and use the snippet.

A single file is the right unit here: it must be pasted as one blob into a console, so splitting across files would be counterproductive.

---

## Task 1: Scaffold + pure helpers

**Files:**
- Create: `src/ally-checks.js`

- [ ] **Step 1: Create the file with config and pure helpers**

```javascript
// Ally Checks Downloader — paste into DevTools console on secure.ally.com.
// Pasting has NO side effects. Start a run with:  await allyChecks.run()
(() => {
  // ===== CONFIG =====
  const CONFIG = {
    MAX_CHECKS: 25,          // primary bound: max checks to download this run
    START_INDEX: 0,          // skip this many checks from the top (manual paging)
    MAX_PAGES: 20,           // safety cap on "View More" clicks
    CHECK_TIMEOUT_MS: 180000, // 3 min per-check wait for images to load
    BETWEEN_CHECKS_MS: 1500,  // polite delay between checks
  };

  // ===== PURE HELPERS =====
  // "−$250.00" (Unicode minus U+2212) -> "250.00"
  function parseAmount(text) {
    return String(text).replace(/[^0-9.]/g, '');
  }

  // "Jun 2, 2026 11:12 pm ET" -> "2026-06-02"
  function parseDate(text) {
    const m = String(text).match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/);
    if (!m) return 'unknown-date';
    const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                     jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
    const mm = months[m[1].slice(0, 3).toLowerCase()] || '00';
    const dd = String(m[2]).padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }

  function sanitize(s) {
    return String(s).replace(/[^A-Za-z0-9._-]/g, '-');
  }

  // -> "2026-06-02_check-1776_250.00_front.png"
  function buildFilename(date, number, amount, side, ext) {
    return `${sanitize(date)}_check-${sanitize(number)}_${sanitize(amount)}_${side}.${ext}`;
  }

  // ===== EXPOSURE (grows in later tasks) =====
  window.allyChecks = { CONFIG, parseAmount, parseDate, sanitize, buildFilename };
  console.log('allyChecks loaded. Helpers available; run() added in a later task.');
})();
```

- [ ] **Step 2: Quick Node sanity check of the parsers**

Run:
```bash
node -e '
const parseAmount = t => String(t).replace(/[^0-9.]/g, "");
const months={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
const parseDate = t => { const m=String(t).match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/); if(!m) return "unknown-date"; return `${m[3]}-${months[m[1].slice(0,3).toLowerCase()]}-${String(m[2]).padStart(2,"0")}`; };
console.log(parseAmount("−$250.00"), "| expect 250.00");
console.log(parseDate("Jun 2, 2026 11:12 pm ET"), "| expect 2026-06-02");
'
```
Expected output:
```
250.00 | expect 250.00
2026-06-02 | expect 2026-06-02
```

- [ ] **Step 3: Commit**

```bash
git add src/ally-checks.js
git commit -m "feat: scaffold ally-checks snippet with config and pure helpers"
```

---

## Task 2: Metadata reader

**Files:**
- Modify: `src/ally-checks.js`

- [ ] **Step 1: Add `sleep`, `getFieldByLabel`, and `readModalMetadata`**

Insert these functions before the `// ===== EXPOSURE` block:

```javascript
  // ===== ASYNC / DOM UTILITIES =====
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Within `root`, find the value next to a bold heading label like "Amount:".
  function getFieldByLabel(root, label) {
    const els = [...root.querySelectorAll('span, div')];
    const labelEl = els.find((el) => el.textContent.trim() === label);
    if (!labelEl) return null;
    const valueEl = labelEl.nextElementSibling;
    return valueEl ? valueEl.textContent.trim() : null;
  }

  // ===== METADATA =====
  function readModalMetadata() {
    const modal = document.querySelector('[data-testid="transaction-detail-modal"]');
    if (!modal) return null;
    const checkNumber = getFieldByLabel(modal, 'Check Number:');
    const postedDateTime = getFieldByLabel(modal, 'Posted:');
    const amountRaw = getFieldByLabel(modal, 'Amount:');
    return {
      checkNumber,
      amount: amountRaw ? parseAmount(amountRaw) : null,
      date: postedDateTime ? parseDate(postedDateTime) : 'unknown-date',
      postedDateTime,
      description: getFieldByLabel(modal, 'Description:'),
      type: getFieldByLabel(modal, 'Type:'),
      recipient: null,
    };
  }
```

- [ ] **Step 2: Add the new functions to the exposure object**

Replace the exposure line with:

```javascript
  window.allyChecks = {
    CONFIG, parseAmount, parseDate, sanitize, buildFilename,
    sleep, getFieldByLabel, readModalMetadata,
  };
```

- [ ] **Step 3: Verify against the live page** *(requires being logged into Ally)*

In a browser on `secure.ally.com`: open a check transaction so the **Transaction details** modal is showing. Open DevTools console, paste the full contents of `src/ally-checks.js`, then run:
```javascript
allyChecks.readModalMetadata()
```
Expected: an object with the correct `checkNumber`, `amount` like `"250.00"`, `date` like `"2026-06-02"`, plus `description`, `type`, `recipient: null`. If any field is `null`, the heading label text differs from what's coded — adjust the label string and re-verify.

- [ ] **Step 4: Commit**

```bash
git add src/ally-checks.js
git commit -m "feat: read check metadata from the transaction detail modal"
```

---

## Task 3: Per-check image download

**Files:**
- Modify: `src/ally-checks.js`

- [ ] **Step 1: Add `expandAndWaitForImages` and `downloadSide`**

Insert before the `// ===== EXPOSURE` block:

```javascript
  // ===== PER-CHECK IMAGE FLOW =====
  // Click the "View check images" accordion (if collapsed) and poll until both
  // blob images are fully loaded. Returns {front, back} or null on timeout.
  async function expandAndWaitForImages(timeoutMs) {
    const btn = [...document.querySelectorAll('button')].find((b) => {
      const h = b.querySelector('h2');
      return h && h.textContent.trim() === 'View check images';
    });
    if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();

    const ready = (el) =>
      el && el.complete && el.naturalWidth > 0 && el.src.startsWith('blob:');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const front = document.querySelector('img[data-testid="frontCheckImage"]');
      const back = document.querySelector('img[data-testid="backCheckImage"]');
      if (ready(front) && ready(back)) return { front, back };
      console.log('… still loading check images');
      await sleep(2000);
    }
    return null;
  }

  // Fetch one blob image and trigger a download. Returns the filename used.
  async function downloadSide(img, meta, side) {
    const resp = await fetch(img.src);
    const blob = await resp.blob();
    const ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
    const filename = buildFilename(meta.date, meta.checkNumber, meta.amount, side, ext);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return filename;
  }
```

- [ ] **Step 2: Add to the exposure object**

Update the exposure object to include the new functions:

```javascript
  window.allyChecks = {
    CONFIG, parseAmount, parseDate, sanitize, buildFilename,
    sleep, getFieldByLabel, readModalMetadata,
    expandAndWaitForImages, downloadSide,
  };
```

- [ ] **Step 3: Verify against the live page** *(requires being logged into Ally)*

With a check transaction's detail modal open (images NOT yet expanded), paste the full file, then run:
```javascript
(async () => {
  const meta = allyChecks.readModalMetadata();
  const imgs = await allyChecks.expandAndWaitForImages(allyChecks.CONFIG.CHECK_TIMEOUT_MS);
  if (!imgs) { console.error('images timed out'); return; }
  console.log(await allyChecks.downloadSide(imgs.front, meta, 'front'));
  console.log(await allyChecks.downloadSide(imgs.back, meta, 'back'));
})()
```
Expected: after the load wait, two files download — e.g. `2026-06-02_check-1776_250.00_front.png` and `_back.png` — at full resolution. The browser may prompt to allow multiple downloads; approve it.

- [ ] **Step 4: Commit**

```bash
git add src/ally-checks.js
git commit -m "feat: expand, wait for, and download front/back check images"
```

---

## Task 4: List navigation (enumerate, open, close)

**Files:**
- Modify: `src/ally-checks.js`

- [ ] **Step 1: Add `findCheckRows`, `openRow`, and `closeModal`**

Insert before the `// ===== EXPOSURE` block:

```javascript
  // ===== LIST / NAVIGATION =====
  // All currently-loaded "Check Paid #<n>" rows, in list order.
  function findCheckRows() {
    return [...document.querySelectorAll('[data-testid="transaction-history-desc"]')]
      .map((btn) => {
        const m = btn.textContent.trim().match(/Check Paid #(\d+)/);
        return m ? { btn, checkNumber: m[1] } : null;
      })
      .filter(Boolean);
  }

  // Click a row and wait for its detail modal to appear.
  async function openRow(row) {
    row.btn.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (document.querySelector('[data-testid="transaction-detail-modal"]')) return true;
    }
    return false;
  }

  // Close the detail modal: Escape first, close-button fallback.
  // NOTE (spec unknown): confirm the close control against the live page.
  async function closeModal() {
    const gone = () => !document.querySelector('[data-testid="transaction-detail-modal"]');
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })
    );
    await sleep(600);
    if (gone()) return true;
    const closeBtn = document.querySelector(
      '[data-testid="transaction-detail-modal"] [aria-label="Close"], button[aria-label="Close"]'
    );
    if (closeBtn) {
      closeBtn.click();
      await sleep(600);
    }
    return gone();
  }
```

- [ ] **Step 2: Add to the exposure object**

```javascript
  window.allyChecks = {
    CONFIG, parseAmount, parseDate, sanitize, buildFilename,
    sleep, getFieldByLabel, readModalMetadata,
    expandAndWaitForImages, downloadSide,
    findCheckRows, openRow, closeModal,
  };
```

- [ ] **Step 3: Verify against the live page** *(requires being logged into Ally)*

On the transaction list (no modal open), paste the full file, then run:
```javascript
(async () => {
  const rows = allyChecks.findCheckRows();
  console.log('check rows found:', rows.map(r => r.checkNumber));
  const opened = await allyChecks.openRow(rows[0]);
  console.log('opened:', opened, allyChecks.readModalMetadata());
  console.log('closed:', await allyChecks.closeModal());
})()
```
Expected: a list of check numbers, the modal opens for the first one with correct metadata, then the modal closes (`closed: true`). **If `closed:` is `false`, capture the modal's close-button HTML and update `closeModal`'s selector**, then re-verify — this is the one known-unconfirmed selector.

- [ ] **Step 4: Commit**

```bash
git add src/ally-checks.js
git commit -m "feat: enumerate check rows, open and close the detail modal"
```

---

## Task 5: Pagination + aggregated output

**Files:**
- Modify: `src/ally-checks.js`

- [ ] **Step 1: Add `clickViewMore` and `downloadJson`**

Insert before the `// ===== EXPOSURE` block:

```javascript
  // Click "View More" and wait for additional rows to load. Returns true if more
  // rows appeared, false if no button or no growth within the timeout.
  async function clickViewMore() {
    const btn = document.querySelector('[data-testid="viewMoreButton"]');
    if (!btn) return false;
    const before = findCheckRows().length;
    btn.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (findCheckRows().length > before) return true;
    }
    return false;
  }

  // ===== AGGREGATION =====
  function downloadJson(records) {
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ally-checks-metadata.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
```

- [ ] **Step 2: Add to the exposure object**

```javascript
  window.allyChecks = {
    CONFIG, parseAmount, parseDate, sanitize, buildFilename,
    sleep, getFieldByLabel, readModalMetadata,
    expandAndWaitForImages, downloadSide,
    findCheckRows, openRow, closeModal,
    clickViewMore, downloadJson,
  };
```

- [ ] **Step 3: Verify against the live page** *(requires being logged into Ally)*

On the transaction list, paste the full file, then run:
```javascript
(async () => {
  const before = allyChecks.findCheckRows().length;
  console.log('grew:', await allyChecks.clickViewMore(), 'before', before, 'after', allyChecks.findCheckRows().length);
  allyChecks.downloadJson([{ checkNumber: 'test', amount: '1.00' }]);
})()
```
Expected: `grew: true` with `after` > `before`, and a file `ally-checks-metadata.json` downloads containing the test record.

- [ ] **Step 4: Commit**

```bash
git add src/ally-checks.js
git commit -m "feat: paginate via View More and emit aggregated metadata JSON"
```

---

## Task 6: The walker (`run`)

**Files:**
- Modify: `src/ally-checks.js`

- [ ] **Step 1: Add the `run` walker**

Insert before the `// ===== EXPOSURE` block:

```javascript
  // ===== WALKER =====
  async function run(overrides = {}) {
    const cfg = { ...CONFIG, ...overrides };
    if (!findCheckRows().length && !document.querySelector('[data-testid="viewMoreButton"]')) {
      alert('No check rows or "View More" found. Open the account transaction list first.');
      return [];
    }

    const records = [];
    const processed = new Set();
    let skipped = 0;
    let pageClicks = 0;

    while (records.length < cfg.MAX_CHECKS) {
      const next = findCheckRows().find((r) => !processed.has(r.checkNumber));

      if (!next) {
        if (pageClicks >= cfg.MAX_PAGES) { console.log('Reached MAX_PAGES.'); break; }
        console.log('Loading more transactions…');
        const grew = await clickViewMore();
        pageClicks += 1;
        if (!grew) { console.log('No more transactions.'); break; }
        continue;
      }

      processed.add(next.checkNumber);

      if (skipped < cfg.START_INDEX) {
        skipped += 1;
        console.log(`Skipping check #${next.checkNumber} (${skipped}/${cfg.START_INDEX})`);
        continue;
      }

      console.log(`Check ${records.length + 1}/${cfg.MAX_CHECKS}: #${next.checkNumber} — opening…`);
      try {
        if (!(await openRow(next))) { console.warn(`  could not open #${next.checkNumber}, skipping`); continue; }
        const meta = readModalMetadata();
        const imgs = await expandAndWaitForImages(cfg.CHECK_TIMEOUT_MS);
        if (!imgs) {
          console.warn(`  images timed out for #${next.checkNumber}, skipping`);
          await closeModal();
          continue;
        }
        meta.frontFile = await downloadSide(imgs.front, meta, 'front');
        meta.backFile = await downloadSide(imgs.back, meta, 'back');
        records.push(meta);
        console.log(`  downloaded ${meta.frontFile} + back`);
      } catch (err) {
        console.error(`  error on #${next.checkNumber}:`, err);
      } finally {
        await closeModal();
        await sleep(cfg.BETWEEN_CHECKS_MS);
      }
    }

    console.log(`Done. Downloaded ${records.length} checks.`);
    console.table(records);
    if (records.length) downloadJson(records);
    return records;
  }
```

- [ ] **Step 2: Add `run` to the exposure object and update the load message**

```javascript
  window.allyChecks = {
    CONFIG, parseAmount, parseDate, sanitize, buildFilename,
    sleep, getFieldByLabel, readModalMetadata,
    expandAndWaitForImages, downloadSide,
    findCheckRows, openRow, closeModal,
    clickViewMore, downloadJson, run,
  };
  console.log('allyChecks loaded. Start with:  await allyChecks.run()  (or allyChecks.run({ MAX_CHECKS: 1 }))');
```

- [ ] **Step 3: Verify a single-check run** *(requires being logged into Ally)*

On the transaction list, paste the full file, then run:
```javascript
await allyChecks.run({ MAX_CHECKS: 1 })
```
Expected: opens the first check, downloads front+back with correct names, closes the modal, prints a one-row table, and downloads `ally-checks-metadata.json`.

- [ ] **Step 4: Verify a small batch with pagination** *(requires being logged into Ally)*

```javascript
await allyChecks.run({ MAX_CHECKS: 3 })
```
Expected: three checks processed (clicking "View More" if needed), 6 images downloaded, a 3-row table, and an aggregated JSON with all three records. Also confirm `START_INDEX` works:
```javascript
await allyChecks.run({ MAX_CHECKS: 1, START_INDEX: 2 })
```
Expected: skips the first two checks and downloads the third.

- [ ] **Step 5: Commit**

```bash
git add src/ally-checks.js
git commit -m "feat: bounded batch walker with pagination, skip offset, and JSON output"
```

---

## Task 7: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write usage instructions**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add usage README for the ally-checks snippet"
```

---

## Self-Review Notes

- **Spec coverage:** blob download (T3), page-text metadata incl. Unicode-minus amount & date parsing (T1/T2), `data-testid` targeting (throughout), View More pagination (T5), bounded walker with `MAX_CHECKS`/`START_INDEX`/`MAX_PAGES` and skip-on-timeout error handling (T6), aggregated JSON + `console.table` (T5/T6), `recipient: null` deferred to OCR (T2), modal-close unknown flagged with confirm-on-live-page step (T4). No formal unit tests, per the build-first decision (T1 keeps a quick parser sanity check only).
- **Type consistency:** the `meta` object shape from `readModalMetadata` (T2) is extended with `frontFile`/`backFile` in `run` (T6) and consumed by `downloadSide`/`downloadJson` consistently. Function names match across exposure objects and call sites.
