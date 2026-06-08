// Options page — settings owned by the service worker (state lives there).
const keyInput = document.getElementById('api-key');
const windowSel = document.getElementById('window');
const status = document.getElementById('status');

chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => {
  keyInput.value = (s && s.anthropicApiKey) || '';
  windowSel.value = String((s && s.defaultWindowMonths) ?? 6);
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
