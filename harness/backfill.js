#!/usr/bin/env node
// Resilient, harness-driven backfill: download every check back to a cutoff date
// (default: 12 months). Unlike `drive.js run` (which executes the whole walker as
// one in-page evaluate and dies if the page navigates), this drives the loop from
// Node — one check per evaluate — and recovers from "execution context destroyed"
// by re-injecting the snippet, re-paginating back to the cutoff, and resuming via
// a harness-side done-set. Progress and the final metadata are owned by Node, so
// a mid-run navigation never loses completed work.
//
//   node harness/backfill.js [months]      # default 12
//
// Images download to ./downloads (CDP). Metadata is written to
// ./downloads/ally-checks-metadata.json (merged with any existing records).

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BROWSER_URL = process.env.ALLY_BROWSER_URL || 'http://127.0.0.1:9222';
const SNIPPET_PATH = path.join(__dirname, '..', 'src', 'ally-checks.js');
const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');
const META_PATH = path.join(DOWNLOAD_DIR, 'ally-checks-metadata.json');

const MONTHS = Number(process.argv[2] || 12);
const MAX_PAGES = 60; // safety cap on View More clicks while paging back
const CHECK_TIMEOUT_MS = 180000; // per-check image wait
const BETWEEN_MS = 1200;
const MAX_ATTEMPTS = 3; // per check, across context-loss recoveries

const MONTH = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDateText(t) {
  const m = String(t).match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mm = MONTH[m[1].slice(0, 3).toLowerCase()];
  if (mm == null) return null;
  return new Date(Number(m[3]), mm, Number(m[2]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isContextLost = (e) =>
  /context was destroyed|Execution context|Target closed|detached/i.test(String(e && e.message));
const isConnClosed = (e) =>
  /Connection closed|ConnectionClosed|WebSocket|Protocol error|Session closed/i.test(String(e && e.message));

// ---- in-page helpers (run via page.evaluate; rely on window.allyChecks) ----
// Live transaction list is a <table>; each transaction is a <tr> whose row text
// begins with its date (e.g. "Jun 7, 2026"). The check number is in the row's
// description button.
function pageListChecks() {
  const DATE = /[A-Za-z]{3,}\s+\d{1,2},\s+\d{4}/;
  return [...document.querySelectorAll('[data-testid="transaction-history-desc"]')]
    .map((b) => {
      const m = (b.textContent || '').match(/Check Paid #(\d+)/);
      if (!m) return null;
      const row = b.closest('tr');
      const dateText = row ? (row.textContent.match(DATE) || [''])[0] : '';
      return { checkNumber: m[1], dateText };
    })
    .filter(Boolean);
}

function pageAllDates() {
  const DATE = /[A-Za-z]{3,}\s+\d{1,2},\s+\d{4}/;
  return [...document.querySelectorAll('[data-testid="transaction-history-desc"]')]
    .map((b) => {
      const row = b.closest('tr');
      return row ? (row.textContent.match(DATE) || [''])[0] : '';
    })
    .filter(Boolean);
}

// Open one check by number, expand+wait for images, read metadata, download both
// sides, close. Returns { ok, record } or { error }.
async function pageProcessCheck(checkNumber, timeoutMs) {
  const A = window.allyChecks;
  if (!A) return { error: 'snippet not injected' };
  const re = new RegExp('Check Paid #' + checkNumber + '(\\D|$)');
  const btn = [...document.querySelectorAll('[data-testid="transaction-history-desc"]')].find((b) =>
    re.test(b.textContent || '')
  );
  if (!btn) return { error: 'row not loaded' };
  btn.click();
  const deadline = Date.now() + 15000;
  let modal = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    modal = document.querySelector('[data-testid="transaction-detail-modal"]');
    if (modal) break;
  }
  if (!modal) return { error: 'modal did not open' };
  const imgs = await A.expandAndWaitForImages(timeoutMs);
  if (!imgs) {
    await A.closeModal();
    return { error: 'images timed out' };
  }
  const meta = A.readModalMetadata();
  if (!meta) {
    await A.closeModal();
    return { error: 'no metadata' };
  }
  if (!meta.checkNumber) meta.checkNumber = checkNumber;
  if (!meta.amount) meta.amount = 'unknown-amount';
  meta.frontFile = await A.downloadSide(imgs.front, meta, 'front');
  meta.backFile = await A.downloadSide(imgs.back, meta, 'back');
  await A.closeModal();
  return { ok: true, record: meta };
}

async function main() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS);
  cutoff.setHours(0, 0, 0, 0);
  console.error(`Backfilling checks on/after ${cutoff.toDateString()} (${MONTHS} months).`);

  const snippet = fs.readFileSync(SNIPPET_PATH, 'utf8');
  let browser, page, client;

  async function connect() {
    browser = await puppeteer.connect({
      browserURL: BROWSER_URL,
      defaultViewport: null,
      protocolTimeout: 3_600_000,
    });
    const ps = await browser.pages();
    page = ps.find((p) => /ally\.com/.test(p.url()));
    if (!page) throw new Error('No Ally tab found (open your Ally transactions page in the debug browser)');
    page.on('pageerror', (err) => console.error('[pageerror] ' + err.message));
  }
  await connect();

  async function ready() {
    // (Re)attach download behavior and (re)inject the snippet if missing.
    client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
    const present = await page.evaluate(() => Boolean(window.allyChecks)).catch(() => false);
    if (!present) {
      await page.evaluate(snippet);
      console.error('  (re)injected snippet');
    }
    // Page back until the oldest loaded transaction reaches the cutoff.
    for (let i = 0; i < MAX_PAGES; i++) {
      const dates = (await page.evaluate(pageAllDates)).map(parseDateText).filter(Boolean);
      const oldest = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
      if (oldest && oldest <= cutoff) break;
      const grew = await page.evaluate(() => window.allyChecks.clickViewMore());
      if (!grew) {
        console.error('  no more history to load');
        break;
      }
    }
  }

  // load existing metadata so re-runs accumulate (dedup by checkNumber)
  const byNum = {};
  if (fs.existsSync(META_PATH)) {
    try {
      for (const r of JSON.parse(fs.readFileSync(META_PATH, 'utf8'))) byNum[r.checkNumber] = r;
    } catch {}
  }

  const done = new Set(Object.keys(byNum));
  const attempts = {};
  let total = 0;

  let connRetries = 0;
  while (true) {
    try {
      await ready();
      const checks = (await page.evaluate(pageListChecks))
        .map((c) => ({ ...c, date: parseDateText(c.dateText) }))
        .filter((c) => c.date && c.date >= cutoff && !done.has(c.checkNumber));

      if (checks.length === 0) break;
      console.error(`${checks.length} check(s) in range still to download.`);

      let progressed = false;
      let lostContext = false;
      for (const c of checks) {
        attempts[c.checkNumber] = (attempts[c.checkNumber] || 0) + 1;
        if (attempts[c.checkNumber] > MAX_ATTEMPTS) {
          console.error(`  #${c.checkNumber}: giving up after ${MAX_ATTEMPTS} attempts`);
          done.add(c.checkNumber);
          progressed = true;
          continue;
        }
        try {
          const res = await page.evaluate(pageProcessCheck, c.checkNumber, CHECK_TIMEOUT_MS);
          if (res.ok) {
            byNum[res.record.checkNumber] = res.record;
            done.add(c.checkNumber);
            total++;
            progressed = true;
            console.error(`  #${c.checkNumber} (${c.dateText}) -> ${res.record.frontFile}`);
            fs.writeFileSync(META_PATH, JSON.stringify(Object.values(byNum), null, 2)); // checkpoint
          } else {
            console.error(`  #${c.checkNumber}: ${res.error} (attempt ${attempts[c.checkNumber]})`);
            if (attempts[c.checkNumber] >= MAX_ATTEMPTS) {
              done.add(c.checkNumber);
              progressed = true;
            }
          }
        } catch (e) {
          if (isConnClosed(e)) throw e; // bubble to the reconnect handler below
          if (isContextLost(e)) {
            console.error(`  context lost on #${c.checkNumber}; recovering…`);
            lostContext = true;
            break; // outer loop re-readies (re-inject + re-paginate) and resumes
          }
          console.error(`  #${c.checkNumber}: ${e.message}`);
          if (attempts[c.checkNumber] >= MAX_ATTEMPTS) {
            done.add(c.checkNumber);
            progressed = true;
          }
        }
        await sleep(BETWEEN_MS);
      }
      if (!progressed && !lostContext) break; // nothing advanced and no recovery pending
    } catch (e) {
      if (isConnClosed(e) && connRetries < 15) {
        connRetries++;
        console.error(`connection dropped (${connRetries}/15); reconnecting…`);
        try { await browser.disconnect(); } catch {}
        await sleep(3000);
        await connect();
        continue;
      }
      throw e;
    }
  }

  fs.writeFileSync(META_PATH, JSON.stringify(Object.values(byNum), null, 2));
  console.error(`\nDone. ${total} new checks downloaded this run; ${Object.keys(byNum).length} total in metadata.`);
  process.stdout.write(JSON.stringify({ downloaded: total, total: Object.keys(byNum).length }) + '\n');
  await browser.disconnect();
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
