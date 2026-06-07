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

  // ===== EXPOSURE (grows in later tasks) =====
  window.allyChecks = {
    CONFIG, parseAmount, parseDate, sanitize, buildFilename,
    sleep, getFieldByLabel, readModalMetadata,
  };
  console.log('allyChecks loaded. Helpers available; run() added in a later task.');
})();
