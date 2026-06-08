// Dashboard (toolbar popup). Capture/review/reconcile UI added in later tasks.
const status = document.getElementById('status');

chrome.runtime.sendMessage({ type: 'ping' }, (r) => {
  status.textContent = r && r.ok ? 'Service worker connected.' : 'Service worker not responding.';
});

document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
