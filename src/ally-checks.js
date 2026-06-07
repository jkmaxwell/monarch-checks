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

  // ===== PER-CHECK IMAGE FLOW =====
  // Click the "View check images" accordion (if collapsed) and poll until both
  // blob images are fully loaded. Returns {front, back} or null on timeout.
  async function expandAndWaitForImages(timeoutMs) {
    const btn = [...document.querySelectorAll('button')].find((b) => {
      const h = b.querySelector('h2');
      return h && h.textContent.trim() === 'View check images';
    });
    if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();

    // Ally renders TWO elements per side: a hidden placeholder (empty src,
    // naturalWidth 0) and the real loaded image (blob: src). Scan all matches
    // and pick the loaded one rather than the first.
    const ready = (el) =>
      el && el.complete && el.naturalWidth > 0 && el.src.startsWith('blob:');
    const pickLoaded = (testid) =>
      [...document.querySelectorAll(`img[data-testid="${testid}"]`)].find(ready);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const front = pickLoaded('frontCheckImage');
      const back = pickLoaded('backCheckImage');
      if (front && back) return { front, back };
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

  // Count ALL transaction rows (every transaction has a description button),
  // not just checks — used to detect that "View More" actually loaded a new page.
  function countTransactionRows() {
    return document.querySelectorAll('[data-testid="transaction-history-desc"]').length;
  }

  // Click "View More" and wait for additional rows to load. Returns true if more
  // rows appeared, false if no button or no growth within the timeout.
  // Measures total transaction rows (not check rows): a page may load only
  // non-check transactions, which still means there is more history to walk.
  async function clickViewMore() {
    const btn = document.querySelector('[data-testid="viewMoreButton"]');
    if (!btn) return false;
    const before = countTransactionRows();
    btn.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (countTransactionRows() > before) return true;
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
        if (!meta) { console.warn(`  modal vanished for #${next.checkNumber}, skipping`); continue; }
        // Guard against missing page text so filenames never contain "null".
        if (!meta.checkNumber) {
          console.warn(`  no check number read for row #${next.checkNumber}; using fallback`);
          meta.checkNumber = `unknown-${records.length}`;
        }
        if (!meta.amount) {
          console.warn(`  no amount read for check #${meta.checkNumber}; using fallback`);
          meta.amount = 'unknown-amount';
        }
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

  // ===== EXPOSURE (grows in later tasks) =====
  window.allyChecks = {
    CONFIG, parseAmount, parseDate, sanitize, buildFilename,
    sleep, getFieldByLabel, readModalMetadata,
    expandAndWaitForImages, downloadSide,
    findCheckRows, openRow, closeModal,
    clickViewMore, downloadJson, run,
  };
  console.log('allyChecks loaded. Start with:  await allyChecks.run()  (or allyChecks.run({ MAX_CHECKS: 1 }))');
})();
