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

// init
chrome.runtime.sendMessage({ type: 'ping' }, (r) => {
  status.textContent = r && r.ok ? 'Ready.' : 'Service worker not responding.';
});
chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => {
  if (s && s.defaultWindowMonths != null) $('window').value = String(s.defaultWindowMonths);
});
refreshDataset();

$('open-options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
$('refresh').addEventListener('click', refreshDataset);

$('capture-btn').addEventListener('click', () => {
  progress.innerHTML = '';
  status.textContent = 'Capturing… keep this popup open.';
  $('capture-btn').disabled = true;
  chrome.runtime.sendMessage({ type: 'capture/start', windowMonths: Number($('window').value) }, (res) => {
    $('capture-btn').disabled = false;
    if (chrome.runtime.lastError) { status.textContent = 'Error: ' + chrome.runtime.lastError.message; return; }
    if (res && res.error) { status.textContent = 'Error: ' + res.error; return; }
    status.textContent = `Done — ${res ? res.captured : 0} new check(s) captured.`;
    refreshDataset();
  });
});

// live progress (broadcast from the content script)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'capture/progress') {
    if (msg.error) logLine(progress, '⚠ ' + msg.error, 'err');
    else logLine(progress, `✓ #${msg.checkNumber} (${msg.date || ''})`);
  } else if (msg?.type === 'capture/done') {
    logLine(progress, `Captured ${msg.captured} this run.`);
  }
});

function refreshDataset() {
  chrome.runtime.sendMessage({ type: 'dataset/get' }, (ds) => {
    const list = Array.isArray(ds) ? ds : [];
    $('count').textContent = String(list.length);
    const ul = $('preview');
    ul.innerHTML = '';
    for (const r of list.slice(-12).reverse()) {
      logLine(ul, `#${r.checkNumber} · ${r.date} · $${r.amount}${r.recipient ? ' · ' + r.recipient : ''}`);
    }
  });
}
