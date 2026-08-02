// Ally capture — self-contained content script (no ES imports allowed here).
// Walks the transaction list, opens each new check, crops the payee strip in-page
// (full image never leaves the page), reads page-text metadata, and streams each
// check to the service worker. Driven by a {type:'capture/run'} message.
//
// Ports the proven logic from src/ally-checks.js (selectors, waits, the
// duplicate-image and modal-open fixes), adapted to a content script.
(() => {
  if (window.__allyChecksCaptureLoaded) return;
  window.__allyChecksCaptureLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DATE_RE = /[A-Za-z]{3,}\s+\d{1,2},\s+\d{4}/;
  const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  // Payee strip as fractions of the detected CHECK box (not the image frame), so
  // it works regardless of image size or how the check is inset/margined.
  const STRIP = { fx: 80 / 1176, fy: 0.27, fw: 780 / 1176, fh: 0.24 };

  const send = (m) => { try { chrome.runtime.sendMessage(m); } catch {} };
  const parseAmount = (t) => String(t == null ? '' : t).replace(/[^0-9.]/g, '');
  function parseDateStr(t) {
    const m = String(t == null ? '' : t).match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/);
    if (!m) return 'unknown-date';
    return `${m[3]}-${MONTHS[m[1].slice(0, 3).toLowerCase()] || '00'}-${String(m[2]).padStart(2, '0')}`;
  }
  function parseDateObj(t) {
    const m = String(t == null ? '' : t).match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/);
    if (!m) return null;
    const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!mm) return null;
    return new Date(Number(m[3]), Number(mm) - 1, Number(m[2]));
  }

  // --- list / navigation ---
  function findCheckRows() {
    return [...document.querySelectorAll('[data-testid="transaction-history-desc"]')]
      .map((btn) => {
        const m = (btn.textContent || '').match(/Check Paid #(\d+)/);
        if (!m) return null;
        const row = btn.closest('tr');
        const dateText = row ? (row.textContent.match(DATE_RE) || [''])[0] : '';
        return { checkNumber: m[1], dateText, date: parseDateObj(dateText), btn };
      })
      .filter(Boolean);
  }
  function countTransactionRows() {
    return document.querySelectorAll('[data-testid="transaction-history-desc"]').length;
  }
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
  async function openByNumber(checkNumber) {
    const re = new RegExp('Check Paid #' + checkNumber + '(\\D|$)');
    const btn = [...document.querySelectorAll('[data-testid="transaction-history-desc"]')]
      .find((b) => re.test(b.textContent || ''));
    if (!btn) return false;
    btn.scrollIntoView({ block: 'center' });
    await sleep(300);
    btn.click();
    const deadline = Date.now() + 20000;
    let reclicked = false;
    while (Date.now() < deadline) {
      await sleep(300);
      if (document.querySelector('[data-testid="transaction-detail-modal"]')) return true;
      if (!reclicked && Date.now() > deadline - 12000) { btn.click(); reclicked = true; }
    }
    return false;
  }
  async function waitForFrontImage(timeoutMs) {
    const ready = (el) => el && el.complete && el.naturalWidth > 0 && (el.src || '').startsWith('blob:');
    const pick = (tid) => [...document.querySelectorAll(`img[data-testid="${tid}"]`)].find(ready);
    const findExpand = () =>
      [...document.querySelectorAll('button')].find((b) => {
        const h = b.querySelector('h2');
        return h && h.textContent.trim() === 'View check images';
      });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const btn = findExpand();
      if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
      const front = pick('frontCheckImage');
      if (front) return front;
      const modal = document.querySelector('[data-testid="transaction-detail-modal"]');
      const mt = modal ? modal.textContent || '' : '';
      if (/can.?t load your check images/i.test(mt)) return 'IMAGE_NOT_READY';
      if (/information isn.?t available right now/i.test(mt)) return 'UNAVAILABLE';
      send({ type: 'capture/heartbeat' }); // keep the popup's "last activity" fresh during the long image wait
      await sleep(2000);
    }
    return null;
  }
  function getField(modal, label) {
    const els = [...modal.querySelectorAll('span, div')];
    const labelEl = els.find((el) => el.textContent.trim() === label);
    return labelEl && labelEl.nextElementSibling ? labelEl.nextElementSibling.textContent.trim() : null;
  }
  function readMetadata() {
    const modal = document.querySelector('[data-testid="transaction-detail-modal"]');
    if (!modal) return null;
    const posted = getField(modal, 'Posted:');
    const amountRaw = getField(modal, 'Amount:');
    return {
      checkNumber: getField(modal, 'Check Number:'),
      amount: amountRaw ? parseAmount(amountRaw) : null,
      date: posted ? parseDateStr(posted) : 'unknown-date',
      postedDateTime: posted || '',
      description: getField(modal, 'Description:') || '',
      type: getField(modal, 'Type:') || 'Withdrawal',
      recipient: null,
    };
  }
  async function closeModal() {
    const gone = () => !document.querySelector('[data-testid="transaction-detail-modal"]');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(600);
    if (gone()) return true;
    const btn = document.querySelector('[data-testid="close-modal"], button[aria-label="close" i]');
    if (btn) { btn.click(); await sleep(600); }
    return gone();
  }

  // --- crop in-page (full image never leaves the tab) ---
  // Find the check's black border box (fractions of the image) via dark-row/column
  // projection. Returns null if it can't find a confident box.
  function detectCheckBox(img) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    let data;
    try { data = ctx.getImageData(0, 0, W, H).data; } catch { return null; }
    const gray = (x, y) => { const i = (y * W + x) * 4; return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; };
    const rowD = new Float32Array(H), colD = new Float32Array(W);
    for (let y = 0; y < H; y++) { let n = 0, t = 0; for (let x = 0; x < W; x += 2) { t++; if (gray(x, y) < 150) n++; } rowD[y] = n / t; }
    for (let x = 0; x < W; x++) { let n = 0, t = 0; for (let y = 0; y < H; y += 2) { t++; if (gray(x, y) < 150) n++; } colD[x] = n / t; }
    // first index that starts a run of >=2 over-threshold entries (skips 1px edge noise)
    const scan = (arr, n, fwd) => {
      let run = 0;
      if (fwd) { for (let i = 0; i < n; i++) { if (arr[i] > 0.35) { if (++run >= 2) return i - 1; } else run = 0; } }
      else { for (let i = n - 1; i >= 0; i--) { if (arr[i] > 0.35) { if (++run >= 2) return i + 1; } else run = 0; } }
      return -1;
    };
    const top = scan(rowD, H, true), bottom = scan(rowD, H, false);
    const left = scan(colD, W, true), right = scan(colD, W, false);
    if (top < 0 || bottom < 0 || left < 0 || right < 0 || bottom - top < H * 0.3 || right - left < W * 0.3) return null;
    return { x: left / W, y: top / H, w: (right - left) / W, h: (bottom - top) / H };
  }

  function cropStrip(img) {
    const box = detectCheckBox(img) || { x: 0, y: 0, w: 1, h: 1 }; // fallback: whole frame
    const x = Math.round((box.x + STRIP.fx * box.w) * img.naturalWidth);
    const y = Math.round((box.y + STRIP.fy * box.h) * img.naturalHeight);
    const w = Math.round(STRIP.fw * box.w * img.naturalWidth);
    const h = Math.round(STRIP.fh * box.h * img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
  }
  // Full front image as JPEG — kept local for manual review when the strip crop
  // misses. JPEG (not PNG) keeps the stored/backed-up bytes reasonable; it's only
  // ever viewed by a human, never sent to the vision API (the strip is).
  function fullToBlob(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.85));
  }
  function blobToB64(blob) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onloadend = () => res(String(r.result).split(',')[1]);
      r.readAsDataURL(blob);
    });
  }

  async function processCheck(checkNumber) {
    if (!(await openByNumber(checkNumber))) throw new Error('modal did not open');
    const front = await waitForFrontImage(180000);
    if (front === 'IMAGE_NOT_READY') { await closeModal(); throw new Error('IMAGE_NOT_READY'); }
    if (front === 'UNAVAILABLE') { await closeModal(); throw new Error('UNAVAILABLE'); }
    if (!front) { await closeModal(); throw new Error('images timed out'); }
    const meta = readMetadata();
    if (!meta) { await closeModal(); throw new Error('no metadata'); }
    if (!meta.checkNumber) meta.checkNumber = checkNumber;
    if (!meta.amount) meta.amount = 'unknown-amount';
    const stripB64 = await blobToB64(await cropStrip(front));
    const fullB64 = await blobToB64(await fullToBlob(front));
    await closeModal();
    return { record: meta, stripB64, fullB64 };
  }

  // --- narrow the list to checks before walking ---
  // Mirrors the manual filter (open search drawer → keyword "check" → all dates →
  // Search) so the walk sees only checks and paginates far less. Best-effort: if
  // any step's element is missing, we bail and capture runs against the unfiltered
  // list (old behavior). The extension's own date cutoff still applies downstream,
  // so "all dates" here is safe.
  const KEYWORDS_SEL = '[data-testid="keywords-text-input"], #keywords';
  // React controls these inputs; assigning .value directly is ignored. Set through
  // the prototype's native setter, then dispatch the event React listens for.
  function setNativeValue(el, proto, val, eventType) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, val);
    el.dispatchEvent(new Event(eventType, { bubbles: true }));
  }
  async function filterToChecks() {
    // Open the drawer if the keyword field isn't already present.
    if (!document.querySelector(KEYWORDS_SEL)) {
      const toggle = document.querySelector(
        '[allytmln="transactionHistory-search"], [data-testid="open-search-drawer-button"], [data-testid="close-search-drawer-button"]'
      );
      if (!toggle) return false;
      toggle.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 5000 && !document.querySelector(KEYWORDS_SEL)) await sleep(200);
    }
    const input = document.querySelector(KEYWORDS_SEL);
    if (!input) return false;
    setNativeValue(input, window.HTMLInputElement.prototype, 'check', 'input');
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const dateSel = document.querySelector('[data-testid="date-picker"], #dateRange');
    if (dateSel) setNativeValue(dateSel, window.HTMLSelectElement.prototype, 'all', 'change');

    const submit = document.querySelector('[data-testid="search-submit-button"]');
    if (!submit) return false;
    submit.click();

    // Settle: wait until every visible transaction row is a check (filter applied)
    // or we time out. Heartbeat so the popup doesn't read the wait as a stall.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(500);
      const total = countTransactionRows();
      if (total > 0 && findCheckRows().length === total) break;
      send({ type: 'capture/heartbeat' });
    }
    await sleep(500);
    return true;
  }

  // --- main run ---
  const MAX_PAGES = 60;
  async function run({ cutoffISO, processed }) {
    const cutoff = cutoffISO ? new Date(cutoffISO) : null;
    const done = new Set((processed || []).map(String));
    let captured = 0, pages = 0;

    try { await filterToChecks(); }
    catch (e) { console.warn('[ally-checks] filterToChecks skipped:', (e && e.message) || e); }

    while (true) {
      const rows = findCheckRows();
      const next = rows.find((r) => !done.has(r.checkNumber) && (!cutoff || (r.date && r.date >= cutoff)));
      if (!next) {
        const dates = rows.map((r) => r.date).filter(Boolean);
        const oldest = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
        // With a cutoff, page until the oldest loaded passes it. All-time (no
        // cutoff): keep paging until there's no more history (View More gone).
        const needMore = cutoff ? oldest && oldest > cutoff : true;
        if (needMore && pages < MAX_PAGES) {
          const grew = await clickViewMore();
          pages++;
          if (!grew) break;
          continue;
        }
        break;
      }
      done.add(next.checkNumber); // skip within this run; only successful capture marks it processed (so not-ready/failed retry next run)
      let ok = false, lastErr, notReady = false, unavailable = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const out = await processCheck(next.checkNumber);
          send({ type: 'capture/check', record: out.record, stripB64: out.stripB64, fullB64: out.fullB64 });
          captured++;
          ok = true;
          send({ type: 'capture/progress', captured, checkNumber: next.checkNumber, date: next.dateText });
        } catch (e) {
          lastErr = e;
          if (e.message === 'IMAGE_NOT_READY') { notReady = true; await closeModal(); break; }
          if (e.message === 'UNAVAILABLE') { unavailable = true; await closeModal(); break; }
          await closeModal(); // clear any half-open state before retrying
          await sleep(1500);
        }
      }
      if (unavailable) {
        // Ally throttling the detail endpoint — stop; resume later (dedup continues).
        send({ type: 'capture/progress', captured, error: 'Ally: "information isn\'t available right now" — it\'s throttling. Stopping; try again later.' });
        break;
      }
      if (notReady) {
        // Too recent — images not scanned yet. Skip and continue to older checks.
        send({ type: 'capture/progress', captured, error: `#${next.checkNumber}: images not posted yet — will retry next run` });
      } else if (!ok) {
        send({ type: 'capture/progress', captured, error: `#${next.checkNumber}: ${lastErr.message} (3 attempts)` });
      }
      await sleep(800);
    }
    send({ type: 'capture/done', captured });
    return { captured };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'capture/run') {
      run(msg).then((r) => sendResponse(r)).catch((e) => sendResponse({ error: String((e && e.message) || e) }));
      return true;
    }
    if (msg && msg.type === 'capture/ping') { sendResponse({ ok: true, host: location.host }); return true; }
  });

  console.log('[ally-checks] capture content script ready on', location.host);
})();
