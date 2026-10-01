// Dashboard popup: capture controls + live progress + dataset preview.
import { keyRow, allyRow, bridgeRow, allOk } from '../lib/readiness.js';
import { bank } from '../lib/banks.js';
const $ = (id) => document.getElementById(id);
const status = $('status');
const progress = $('progress');

function logLine(ul, text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  ul.prepend(li);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtAmount(a) {
  const n = Number(a);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(a == null ? '' : a);
}

// --- live run-state status pill ---
const banner = $('runbanner');
const bannerText = $('runbanner-text');
const LABELS = { capture: 'Capturing checks', extract: 'Extracting recipients', reconcile: 'Reconciling' };
function setBusy(b) {
  $('capture-btn').disabled = b;
  $('extract-btn').dataset.busy = b ? '1' : '0';
  // Extract also needs an API key; the setup check owns that part of the flag.
  $('extract-btn').disabled = b || document.querySelector('#setup-rows li[data-check="key"]').dataset.state !== 'ok';
}
function renderStatus(rs) {
  if (!rs || !rs.active) { bannerText.textContent = 'Idle — no run in progress'; banner.className = 'pill idle'; setBusy(false); return; }
  const ago = rs.lastActivityAt ? Math.round((Date.now() - rs.lastActivityAt) / 1000) : null;
  let t = `${LABELS[rs.active] || rs.active}…`;
  if (rs.active === 'capture' && rs.count != null) t += ` (${rs.count} in dataset)`;
  if (rs.active === 'reconcile' && rs.total) t += ` (check ${rs.i || 0}/${rs.total})`;
  if (ago != null) t += ` · last activity ${ago}s ago${ago > 120 ? ' — may be stalled' : ''}`;
  bannerText.textContent = t;
  banner.className = 'pill busy';
  setBusy(true);
}
function pollStatus() { chrome.runtime.sendMessage({ type: 'status/get' }, (rs) => { if (!chrome.runtime.lastError) renderStatus(rs); }); }
pollStatus();
setInterval(pollStatus, 3000);

// init
chrome.runtime.sendMessage({ type: 'ping' }, (r) => {
  status.textContent = r && r.ok ? 'Ready.' : 'Service worker not responding.';
});
chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => {
  if (s && s.defaultWindowMonths != null) $('window').value = String(s.defaultWindowMonths);
});
refreshDataset();

// Open options in a tab directly — openOptionsPage() throws in some Chromium
// builds (e.g. Dia: "Could not create an options page").
$('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
});
$('recheck-btn').addEventListener('click', () => {
  const n = $('recheck-num').value.trim();
  if (!n) return;
  chrome.runtime.sendMessage({ type: 'capture/recheck', checkNumber: n }, () => {
    progress.innerHTML = '';
    status.textContent = `Re-capturing #${n}… (scanning all history to find it)`;
    $('capture-btn').disabled = true;
    // Always all-time for a targeted re-capture so the window setting can't strand it.
    chrome.runtime.sendMessage({ type: 'capture/start', windowMonths: 0 }, () => void chrome.runtime.lastError);
  });
});
$('refresh').addEventListener('click', refreshDataset);
$('review-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') });
});

$('capture-btn').addEventListener('click', () => {
  progress.innerHTML = '';
  status.textContent = 'Capturing… (you can close this popup; it keeps running)';
  $('capture-btn').disabled = true;
  chrome.runtime.sendMessage({ type: 'capture/start', windowMonths: Number($('window').value) }, () => void chrome.runtime.lastError);
});

$('extract-btn').addEventListener('click', () => {
  progress.innerHTML = '';
  status.textContent = 'Extracting recipients… (keeps running if popup closes)';
  $('extract-btn').disabled = true;
  chrome.runtime.sendMessage({ type: 'extract/start' }, () => void chrome.runtime.lastError);
});

// live progress + done (broadcast from the content script / SW)
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'capture/progress') {
    if (msg.error) logLine(progress, '⚠ ' + msg.error, 'err');
    else logLine(progress, `✓ #${msg.checkNumber} (${msg.date || ''})`);
  } else if (msg.type === 'capture/done') {
    logLine(progress, `Captured ${msg.captured} this run.`);
    status.textContent = msg.error ? 'Error: ' + msg.error : `Done — ${msg.captured} new check(s) captured.`;
    refreshDataset(); pollStatus();
  } else if (msg.type === 'extract/progress') {
    logLine(progress, `${msg.done}/${msg.total} · #${msg.checkNumber} → ${msg.recipient || '∅'} [${msg.confidence}]`);
  } else if (msg.type === 'extract/done') {
    status.textContent = msg.error ? 'Error: ' + msg.error : `Extracted ${msg.extracted} recipient(s).`;
    refreshDataset(); pollStatus();
  }
});

function refreshDataset() {
  chrome.runtime.sendMessage({ type: 'dataset/get' }, (ds) => {
    const list = Array.isArray(ds) ? ds : [];
    $('count').textContent = String(list.length);
    const needs = list.filter((r) => !r.recipient).length;
    $('needs').textContent = String(needs);
    $('needs').parentElement.classList.toggle('attention', needs > 0);
    const ul = $('preview');
    ul.innerHTML = '';
    for (const r of list.slice(-12).reverse()) {
      const li = document.createElement('li');
      li.className = 'rowline';
      li.innerHTML =
        `<span class="num">#${esc(r.checkNumber)}</span>` +
        `<span class="date">${esc(r.date)}</span>` +
        `<span class="rec">${esc(r.recipient || '')}</span>` +
        `<span class="amt">$${esc(fmtAmount(r.amount))}</span>`;
      ul.appendChild(li);
    }
  });
}

// --- setup checklist ---
// Facts are gathered here; copy/state decisions live in lib/readiness.js.
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
let setupTimer = null;
let setupExpanded = false; // user clicked Details while all green

function renderRow(key, row) {
  const li = document.querySelector(`#setup-rows li[data-check="${key}"]`);
  li.dataset.state = row.state;
  li.querySelector('.state').textContent = row.text;
  const fix = li.querySelector('.fix');
  if (row.fix) { fix.textContent = row.fix.label; fix.dataset.action = row.fix.action; fix.hidden = false; }
  else { fix.hidden = true; delete fix.dataset.action; }
}

async function runSetupChecks() {
  const settings = await send({ type: 'settings/get' });
  const b = bank(settings && settings.bank);

  const key = keyRow(settings);
  renderRow('key', key);
  $('extract-btn').disabled = key.state !== 'ok' || $('extract-btn').dataset.busy === '1';
  $('extract-btn').title = key.state === 'ok' ? '' : 'Set your Claude API key in Settings first';

  renderRow('ally', allyRow(null, b.label));
  renderRow('bridge', bridgeRow(null));

  const tabs = await new Promise((resolve) => chrome.tabs.query({ url: b.tabMatch }, (t) => resolve(chrome.runtime.lastError ? [] : t)));
  const ally = allyRow(tabs.length, b.label);
  renderRow('ally', ally);

  const ready = await send({ type: 'monarch/ready' });
  const bridge = bridgeRow(ready || { ok: false, mode: 'local', error: 'Service worker not responding' });
  renderRow('bridge', bridge);

  const ok = allOk([key, ally, bridge]);
  const card = $('setup');
  card.classList.toggle('collapsed', ok && !setupExpanded);
  $('setup-toggle').hidden = !ok;
  $('setup-toggle').textContent = setupExpanded ? 'Hide' : 'Details';

  clearTimeout(setupTimer);
  if (!ok) setupTimer = setTimeout(runSetupChecks, 5000);
}

$('setup-toggle').addEventListener('click', (e) => {
  e.preventDefault();
  setupExpanded = !setupExpanded;
  $('setup').classList.toggle('collapsed', !setupExpanded);
  $('setup-toggle').textContent = setupExpanded ? 'Hide' : 'Details';
});

$('setup-rows').addEventListener('click', (e) => {
  const a = e.target.closest('a.fix');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.action === 'open-bank') {
    chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => chrome.tabs.create({ url: bank(s && s.bank).homeUrl }));
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  }
});

// Kick off after the helpers above exist (module-level consts are not hoisted).
runSetupChecks();
