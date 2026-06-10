// Options page — settings owned by the service worker (state lives there).
const keyInput = document.getElementById('api-key');
const windowSel = document.getElementById('window');
const status = document.getElementById('status');

chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => {
  keyInput.value = (s && s.anthropicApiKey) || '';
  windowSel.value = String((s && s.defaultWindowMonths) ?? 6);
});

// --- Monarch connection ---
const mStatus = document.getElementById('monarch-status');
const toolsOut = document.getElementById('tools-out');
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function refreshMonarch() {
  send({ type: 'monarch/status' }).then((s) => {
    mStatus.textContent = s && s.connected ? `Connected (scopes: ${s.scopes || '—'}).` : 'Not connected.';
  });
}
refreshMonarch();

document.getElementById('monarch-connect').addEventListener('click', async () => {
  mStatus.textContent = 'Opening Monarch consent…';
  const r = await send({ type: 'monarch/connect' });
  mStatus.textContent = r && r.error ? 'Error: ' + r.error : `Connected (scopes: ${r.scopes || '—'}).`;
});
document.getElementById('monarch-revoke').addEventListener('click', async () => {
  await send({ type: 'monarch/revoke' });
  refreshMonarch();
});
document.getElementById('monarch-tools').addEventListener('click', async () => {
  toolsOut.style.display = 'block';
  toolsOut.textContent = 'Listing tools…';
  const r = await send({ type: 'monarch/tools' });
  toolsOut.textContent = r && r.error ? 'Error: ' + r.error : JSON.stringify(r, null, 2);
});

document.getElementById('monarch-probe').addEventListener('click', async () => {
  toolsOut.style.display = 'block';
  toolsOut.textContent = 'Probing a check against Monarch (read-only)…';
  const r = await send({ type: 'monarch/probe' });
  toolsOut.textContent = r && r.error ? 'Error: ' + r.error : JSON.stringify(r, null, 2);
});

document.getElementById('reset').addEventListener('click', async () => {
  if (!confirm('Clear ALL captured checks, strips, and history? (Your API key, Monarch connection, and name map are kept.)')) return;
  await send({ type: 'data/reset' });
  status.textContent = 'Cleared — ready to capture fresh.';
});

document.getElementById('save').addEventListener('click', () => {
  const partial = {
    anthropicApiKey: keyInput.value.trim(),
    defaultWindowMonths: Number(windowSel.value),
  };
  chrome.runtime.sendMessage({ type: 'settings/patch', partial }, () => {
    status.textContent = 'Saved.';
    setTimeout(() => (status.textContent = ''), 1500);
  });
});
