// Service worker: message router + (later) all cross-origin fetches to Anthropic
// and Monarch (CORS bypassed here via host_permissions). ES module.
import * as storage from '../lib/storage.js';

chrome.runtime.onInstalled.addListener(() => console.log('Ally Checks installed'));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true; // async response
});

async function handle(msg, sender) {
  switch (msg?.type) {
    case 'ping':
      return { ok: true };
    case 'settings/get':
      return await storage.get('settings');
    case 'settings/patch':
      return await storage.patch('settings', msg.partial || {});
    // capture/* , extract/* , reconcile/* routes are added in later tasks.
    default:
      return { error: 'unknown message: ' + msg?.type };
  }
}
