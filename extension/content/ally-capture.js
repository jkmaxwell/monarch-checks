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
  const CROP = { x: 80, y: 150, w: 780, h: 95, baseW: 1176, baseH: 512 }; // validated region

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
  function cropStrip(img) {
    // Scale per-axis so the crop stays proportional even if the check image has a
    // different aspect ratio (otherwise a fixed y lands on the wrong row).
    const sx = img.naturalWidth / CROP.baseW;
    const sy = img.naturalHeight / CROP.baseH;
    const x = Math.round(CROP.x * sx), y = Math.round(CROP.y * sy);
    const w = Math.round(CROP.w * sx), h = Math.round(CROP.h * sy);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
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
    if (!front) { await closeModal(); throw new Error('images timed out'); }
    const meta = readMetadata();
    if (!meta) { await closeModal(); throw new Error('no metadata'); }
    if (!meta.checkNumber) meta.checkNumber = checkNumber;
    if (!meta.amount) meta.amount = 'unknown-amount';
    const stripB64 = await blobToB64(await cropStrip(front));
    await closeModal();
    return { record: meta, stripB64 };
  }

  // --- main run ---
  const MAX_PAGES = 60;
  async function run({ cutoffISO, processed }) {
    const cutoff = cutoffISO ? new Date(cutoffISO) : null;
    const done = new Set((processed || []).map(String));
    let captured = 0, pages = 0;

    while (true) {
      const rows = findCheckRows();
      const next = rows.find((r) => !done.has(r.checkNumber) && (!cutoff || (r.date && r.date >= cutoff)));
      if (!next) {
        const dates = rows.map((r) => r.date).filter(Boolean);
        const oldest = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
        if (cutoff && oldest && oldest > cutoff && pages < MAX_PAGES) {
          const grew = await clickViewMore();
          pages++;
          if (!grew) break;
          continue;
        }
        break;
      }
      done.add(next.checkNumber);
      let ok = false, lastErr;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const out = await processCheck(next.checkNumber);
          send({ type: 'capture/check', record: out.record, stripB64: out.stripB64 });
          captured++;
          ok = true;
          send({ type: 'capture/progress', captured, checkNumber: next.checkNumber, date: next.dateText });
        } catch (e) {
          lastErr = e;
          await closeModal(); // clear any half-open state before retrying
          await sleep(1500);
        }
      }
      if (!ok) send({ type: 'capture/progress', captured, error: `#${next.checkNumber}: ${lastErr.message} (3 attempts)` });
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
