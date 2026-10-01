// Review page (full tab): payee strip + editable recipient (autocomplete) per
// check, reading the dataset from the SW and the strips from IndexedDB. Edits
// save back to the SW automatically.
import { getStrip, getFull } from '../lib/idb.js';

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let records = [];
let merchants = [];              // [{ name, merchant_id }] from Monarch (official MCP)
let merchantByName = new Map();  // lowercased name → merchant_id, for id capture on save

// "1800.00" -> "1,800.00" (falls back to the raw string for non-numbers)
function fmtAmount(a) {
  const n = Number(a);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(a == null ? '' : a);
}

// Keep the sticky column headers pinned just under the (wrap-able) header bar.
function syncStickyOffset() {
  const h = document.querySelector('header');
  if (h) document.documentElement.style.setProperty('--th-top', h.offsetHeight + 'px');
}
window.addEventListener('resize', syncStickyOffset);

async function load() {
  records = (await send({ type: 'dataset/get' })) || [];
  render();
  // Pull the Monarch merchant list for autocomplete + id capture. Best-effort:
  // empty in local mode or if Monarch isn't connected, so this never blocks the
  // page — it just re-renders the datalist once names arrive.
  const mres = await send({ type: 'merchants/search' });
  merchants = (mres && mres.merchants) || [];
  merchantByName = new Map(
    merchants.filter((m) => m && m.name).map((m) => [m.name.trim().toLowerCase(), m.merchant_id])
  );
  buildDatalist();
}

// Suggestions = corrected recipient names (by frequency) then any Monarch
// merchant names not already listed. Picking a Monarch name lets save() capture
// its merchant_id so reconcile assigns by id instead of re-matching by string.
function buildDatalist() {
  const counts = {};
  for (const r of records) { const n = (r.recipient || '').trim(); if (n) counts[n] = (counts[n] || 0) + 1; }
  const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const seen = new Set(names.map((n) => n.toLowerCase()));
  for (const m of merchants) {
    const n = (m.name || '').trim();
    if (n && !seen.has(n.toLowerCase())) { names.push(n); seen.add(n.toLowerCase()); }
  }
  $('recipient-list').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function render() {
  buildDatalist();
  // Already-reconciled checks drop to the bottom in a group hidden by default —
  // a re-scan only puts you in front of new or edited checks.
  const pending = records.filter((r) => !r.reconciled);
  const done = records.filter((r) => r.reconciled);
  const ordered = pending.concat(done);
  const needsReview = pending.filter((r) => r.confidence !== 'high' || !r.recipient).length;

  $('hint').textContent =
    `${records.length} checks · ${needsReview} need review` +
    (done.length ? ` · ${done.length} reconciled` : '');
  const toggle = $('toggle-done');
  toggle.hidden = done.length === 0;
  toggle.textContent = document.body.classList.contains('show-done')
    ? 'Hide reconciled' : `Show ${done.length} reconciled`;

  const tbody = $('rows');
  tbody.innerHTML = '';
  for (const r of ordered) {
    const tr = document.createElement('tr');
    if (r.reconciled) tr.className = 'reconciled';
    else if (r.confidence !== 'high' || !r.recipient) tr.className = 'needs-review';
    const conf = r.reconciled
      ? '<span class="badge synced">✓ in Monarch</span>'
      : `<span class="badge ${esc(r.confidence || 'low')}">${esc(r.confidence || 'low')}</span>`;
    tr.innerHTML =
      `<td class="num">${esc(r.checkNumber)}</td>` +
      `<td class="strip"><div class="frame" data-check="${esc(r.checkNumber)}">` +
        `<span class="ph">check scan · payee strip #${esc(r.checkNumber)}</span></div>` +
        `<button type="button" class="full-toggle" data-check="${esc(r.checkNumber)}">Crop wrong? Show full check</button>` +
        `<div class="full-frame" data-check="${esc(r.checkNumber)}" hidden></div></td>` +
      `<td class="rec"><input type="text" list="recipient-list" autocomplete="off" value="${esc(r.recipient || '')}" data-check="${esc(r.checkNumber)}"></td>` +
      `<td class="conf">${conf}</td>` +
      `<td class="amt">${esc(fmtAmount(r.amount))}</td>` +
      `<td class="date">${esc(r.date)}</td>`;
    tbody.appendChild(tr);
  }
  for (const frame of tbody.querySelectorAll('.frame[data-check]')) {
    getStrip(frame.dataset.check).then((blob) => {
      if (!blob) return; // keep the hatched placeholder
      const img = document.createElement('img');
      img.alt = 'payee strip ' + frame.dataset.check;
      img.src = URL.createObjectURL(blob);
      frame.replaceChildren(img);
    });
  }
  syncStickyOffset();
}

// Show/hide the full front check when a crop missed the payee. The full image is
// stored locally (IndexedDB, JPEG) and loaded lazily on first expand; checks
// captured before this feature won't have one (recapture via the popup to get it).
$('rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('.full-toggle');
  if (!btn) return;
  const check = btn.dataset.check;
  const frame = $('rows').querySelector(`.full-frame[data-check="${CSS.escape(check)}"]`);
  if (!frame) return;
  if (!frame.hidden) {
    frame.hidden = true;
    btn.textContent = 'Crop wrong? Show full check';
    return;
  }
  if (!frame.dataset.loaded) {
    frame.dataset.loaded = '1';
    const blob = await getFull(check);
    if (!blob) {
      frame.innerHTML = '<span class="ph">no full image — cleared after sync, or captured before this feature; recapture to get one</span>';
    } else {
      const img = document.createElement('img');
      img.alt = 'full check ' + check;
      img.src = URL.createObjectURL(blob);
      frame.replaceChildren(img);
    }
  }
  frame.hidden = false;
  btn.textContent = 'Hide full check';
});

// Save on commit (blur / Enter), not on every keystroke — avoids persisting a
// half-typed value like "Ia".
$('rows').addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-check]');
  if (!input) return;
  const check = input.dataset.check;
  const val = input.value.trim();
  const rec = records.find((r) => String(r.checkNumber) === String(check));
  const original = rec ? (rec.recipient || '') : ''; // pre-edit value → learned as an alias
  const merchantId = merchantByName.get(val.toLowerCase()) || null; // matched a real Monarch merchant?
  await send({ type: 'dataset/setRecipient', checkNumber: check, recipient: val, confidence: 'high', original, merchantId });
  let wasReconciled = false;
  if (rec) {
    // Match the SW's stamp-invalidation: a real change pulls the check back into
    // the review queue, so re-render to move it out of the reconciled group.
    if (rec.reconciled && (rec.reconciled.recipient !== val || (rec.reconciled.merchant_id || null) !== (merchantId || null))) {
      delete rec.reconciled; wasReconciled = true;
    }
    rec.recipient = val; rec.confidence = 'high';
    if (merchantId) rec.merchantId = merchantId; else delete rec.merchantId;
  }
  if (wasReconciled) { render(); $('status').textContent = `Saved #${check} — back in review (was reconciled).`; return; }
  buildDatalist(); // corrected names become autocomplete suggestions immediately
  const row = input.closest('tr');
  row.classList.remove('needs-review');
  const badge = row.querySelector('.badge');
  badge.textContent = 'high';
  badge.className = 'badge high';
  $('status').textContent = `Saved #${check}.`;
});

// Toggle the collapsed reconciled group.
$('toggle-done').addEventListener('click', () => {
  document.body.classList.toggle('show-done');
  render();
});

// Export full-field CSV + JSON, client-side.
function csvEscape(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCsv(rows) {
  const PREFERRED = ['checkNumber', 'date', 'amount', 'recipient', 'confidence', 'type', 'description', 'postedDateTime'];
  const seen = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  const cols = PREFERRED.filter((k) => seen.includes(k)).concat(seen.filter((k) => !PREFERRED.includes(k)));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n') + '\n';
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
$('export').addEventListener('click', () => {
  const clean = records.map(({ extractError, ...r }) => r);
  download('monarch-checks-verified.csv', toCsv(clean), 'text/csv');
  download('monarch-checks-verified.json', JSON.stringify(clean, null, 2), 'application/json');
  $('status').textContent = `Exported ${clean.length} checks.`;
});

// --- reconcile (Phase 4) ---
// The run log + position are persisted by the engine and POLLED here (with the
// broadcasts as a fast path), so progress survives Dia discarding/reloading
// this tab mid-run — a freshly opened review page picks a run up in progress.
const reconDiv = $('recon');
const reconLog = $('recon-log');
function reconLine(entry) {
  const li = document.createElement('li');
  const st = entry.status || '';
  li.className = st === 'written' ? 'w' : st === 'skipped' ? 's' : st.startsWith('would') ? 'p' : 'f';
  li.textContent =
    `#${entry.checkNumber} ${entry.recipient || ''} — ${st}` +
    (entry.flagReason ? ` (${entry.flagReason})` : '') +
    (entry.flag ? ` [${entry.flag}]` : '');
  reconLog.prepend(li);
}

let activeDryRun = false;
let renderedLogCount = -1;
function renderLogEntries(list) {
  if (!Array.isArray(list) || list.length === renderedLogCount) return;
  renderedLogCount = list.length;
  reconLog.innerHTML = '';
  for (const entry of list) reconLine(entry); // prepend → newest first
}
async function refreshReconLog() {
  const list = (await send({ type: 'runlog/get' })) || [];
  renderLogEntries(list);
  return list;
}
function summarize(list, dryRun) {
  const count = (s) => list.filter((en) => (en.status || '').startsWith(s)).length;
  return `${dryRun ? 'Dry run' : 'Done'}: ${count('written')} written, ${count('would')} would-write, ` +
    `${count('skipped')} skipped, ${count('flagged')} flagged.`;
}

let reconWasActive = false;
async function pollRecon() {
  const rs = await send({ type: 'status/get' });
  if (rs && rs.active === 'reconcile') {
    reconWasActive = true;
    activeDryRun = rs.dryRun != null ? Boolean(rs.dryRun) : activeDryRun;
    reconDiv.hidden = false;
    $('dryrun').disabled = true; $('reconcile').disabled = true;
    if (rs.total) {
      const ago = rs.lastActivityAt ? Math.round((Date.now() - rs.lastActivityAt) / 1000) : null;
      $('recon-summary').textContent =
        `${activeDryRun ? 'Dry run' : 'Reconciling'} — check ${rs.i || 0}/${rs.total}` +
        (rs.checkNumber ? ` (#${rs.checkNumber})` : '') +
        (ago != null && ago > 45 ? ` · last activity ${ago}s ago — may be stalled` : '') + '…';
    }
    await refreshReconLog();
  } else if (reconWasActive) {
    // Run ended while we were watching via polls (done broadcast may have been
    // missed) — render the final log and compute the summary from it.
    reconWasActive = false;
    $('dryrun').disabled = false; $('reconcile').disabled = false;
    $('recon-summary').textContent = summarize(await refreshReconLog(), activeDryRun);
  }
}
// On open: if a run isn't active but a persisted log exists, show the last
// run's results (e.g. the dry run that finished while the tab was discarded).
(async () => {
  await pollRecon();
  if (!reconWasActive) {
    const list = await refreshReconLog();
    if (list.length) {
      reconDiv.hidden = false;
      const wasDry = list.some((en) => (en.status || '').startsWith('would'));
      $('recon-summary').textContent = 'Last run — ' + summarize(list, wasDry);
    }
  }
})();
setInterval(pollRecon, 3000);
function runReconcile(dryRun) {
  activeDryRun = dryRun;
  reconWasActive = true;
  reconDiv.hidden = false;
  reconLog.innerHTML = '';
  renderedLogCount = 0; // engine clears the stored log at run start
  $('recon-summary').textContent = dryRun ? 'Dry run — computing, no writes…' : 'Reconciling — writing to Monarch…';
  $('dryrun').disabled = true; $('reconcile').disabled = true;
  // Fire-and-forget; results arrive via reconcile/progress + reconcile/done.
  chrome.runtime.sendMessage({ type: 'reconcile/run', dryRun }, () => void chrome.runtime.lastError);
}
$('dryrun').addEventListener('click', () => runReconcile(true));
$('reconcile').addEventListener('click', () => {
  if (!confirm('This writes merchant + category changes to your LIVE Monarch account. Run a Dry run first if you haven’t. Continue?')) return;
  runReconcile(false);
});
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'reconcile/progress') {
    if (msg.entry) refreshReconLog(); // storage is the source of truth — no double-render
    else if (msg.phase === 'check') {
      // Live per-check progress — the engine sends this before it starts each
      // check, so the page never looks dead between log entries.
      $('recon-summary').textContent =
        `${activeDryRun ? 'Dry run' : 'Reconciling'} — check ${msg.i}/${msg.total} (#${msg.checkNumber})…`;
    }
  } else if (msg.type === 'reconcile/done') {
    reconWasActive = false; // keep the poll from overwriting this summary
    refreshReconLog();
    $('dryrun').disabled = false; $('reconcile').disabled = false;
    if (msg.error) {
      $('recon-summary').textContent = 'Stopped: ' + msg.error + ' ';
      if (msg.error.includes('app.monarchmoney.com')) {
        const a = document.createElement('a');
        a.href = 'https://app.monarchmoney.com/accounts?reconnect=plaid_migration';
        a.target = '_blank';
        a.textContent = 'Open Monarch accounts →';
        $('recon-summary').appendChild(a);
      }
      return;
    }
    $('recon-summary').textContent =
      `${msg.dryRun ? 'Dry run' : 'Done'}: ${msg.written} written, ${msg.would} would-write, ` +
      `${msg.skipped} skipped, ${msg.flagged} flagged · ${msg.merges} merchant merge(s).`;
  }
});

load();
