// Dashboard popup: capture controls + live progress + dataset preview.
const $ = (id) => document.getElementById(id);
const status = $('status');
const progress = $('progress');

function logLine(ul, text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  ul.prepend(li);
}

// --- live run-state banner ---
const banner = $('runbanner');
const LABELS = { capture: 'Capturing checks', extract: 'Extracting recipients', reconcile: 'Reconciling' };
function setBusy(b) { $('capture-btn').disabled = b; $('extract-btn').disabled = b; }
function renderStatus(rs) {
  if (!rs || !rs.active) { banner.textContent = 'Idle — no run in progress.'; banner.className = 'hint'; setBusy(false); return; }
  const ago = rs.lastActivityAt ? Math.round((Date.now() - rs.lastActivityAt) / 1000) : null;
  let t = `● ${LABELS[rs.active] || rs.active}…`;
  if (rs.active === 'capture' && rs.count != null) t += ` (${rs.count} in dataset)`;
  if (ago != null) t += ` · last activity ${ago}s ago${ago > 120 ? ' — may be stalled' : ''}`;
  banner.textContent = t;
  banner.className = 'running';
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
    status.textContent = `Re-capturing #${n}…`;
    $('capture-btn').disabled = true;
    chrome.runtime.sendMessage({ type: 'capture/start', windowMonths: Number($('window').value) }, () => void chrome.runtime.lastError);
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
    $('needs').textContent = String(list.filter((r) => !r.recipient).length);
    const ul = $('preview');
    ul.innerHTML = '';
    for (const r of list.slice(-12).reverse()) {
      logLine(ul, `#${r.checkNumber} · ${r.date} · $${r.amount}${r.recipient ? ' · ' + r.recipient : ''}`);
    }
  });
}
