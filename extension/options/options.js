// Options page — settings owned by the service worker (state lives there).
const keyInput = document.getElementById('api-key');
const windowSel = document.getElementById('window');
const status = document.getElementById('status');

const mcpMode = document.getElementById('mcp-mode');
const mcpUrl = document.getElementById('mcp-url');
const mcpLocalRow = document.getElementById('mcp-local-row');

chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => {
  keyInput.value = (s && s.anthropicApiKey) || '';
  windowSel.value = String((s && s.defaultWindowMonths) ?? 6);
  document.getElementById('bank').value = (s && s.bank) || 'ally';
  mcpMode.value = (s && s.mcpMode) || 'local';
  mcpUrl.value = (s && s.mcpLocalUrl) || 'http://127.0.0.1:8642/mcp';
  syncMcpUi();
});

function syncMcpUi() {
  const local = mcpMode.value === 'local';
  mcpLocalRow.style.display = local ? '' : 'none';
  document.getElementById('monarch-connect').style.display = local ? 'none' : '';
  document.getElementById('monarch-revoke').style.display = local ? 'none' : '';
}
mcpMode.addEventListener('change', syncMcpUi);

// --- Monarch connection ---
const mStatus = document.getElementById('monarch-status');
const toolsOut = document.getElementById('tools-out');
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function refreshMonarch() {
  send({ type: 'monarch/status' }).then((s) => {
    if (s && s.mode === 'local') {
      mStatus.textContent = `Local server mode (${s.url}) — no OAuth needed; use "List tools" to test the connection.`;
    } else {
      mStatus.textContent = s && s.connected ? `Connected (scopes: ${s.scopes || '—'}).` : 'Not connected.';
    }
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

// --- backup & restore ---
const backupStatus = document.getElementById('backup-status');

document.getElementById('export').addEventListener('click', async () => {
  backupStatus.textContent = 'Exporting…';
  const snap = await send({ type: 'data/export' });
  if (!snap || snap.error) { backupStatus.textContent = 'Error: ' + (snap && snap.error); return; }
  const blob = new Blob([JSON.stringify(snap)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ally-checks-backup-${snap.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  backupStatus.textContent = `Exported ${snap.dataset.length} check(s) + ${Object.keys(snap.strips).length} strip(s).`;
});

document.getElementById('import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  backupStatus.textContent = 'Importing…';
  try {
    const snapshot = JSON.parse(await file.text());
    const r = await send({ type: 'data/import', snapshot });
    backupStatus.textContent = r && r.error
      ? 'Error: ' + r.error
      : `Restored ${r.checks} check(s) + ${r.strips} strip(s).`;
  } catch (err) {
    backupStatus.textContent = 'Error: ' + err.message;
  }
  e.target.value = '';
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
    bank: document.getElementById('bank').value,
    mcpMode: mcpMode.value,
    mcpLocalUrl: mcpUrl.value.trim() || 'http://127.0.0.1:8642/mcp',
  };
  chrome.runtime.sendMessage({ type: 'settings/patch', partial }, () => {
    status.textContent = 'Saved.';
    refreshMonarch();
    setTimeout(() => (status.textContent = ''), 1500);
  });
});
