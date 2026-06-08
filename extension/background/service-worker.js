// Service worker: message router + capture orchestration. All cross-origin
// fetches (Anthropic, Monarch) will live here (CORS bypassed via host_permissions).
// ES module.
import * as storage from '../lib/storage.js';
import * as idb from '../lib/idb.js';
import { b64ToBlob } from '../lib/util.js';

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
    case 'dataset/get':
      return await storage.get('dataset');

    case 'capture/start':
      return await startCapture(msg);
    case 'capture/check':
      await onCheckCaptured(msg);
      return { ok: true };
    case 'capture/progress':
    case 'capture/done':
      return { ok: true }; // dashboard listens to these for UI; SW persists via capture/check

    default:
      return { error: 'unknown message: ' + msg?.type };
  }
}

async function startCapture({ windowMonths }) {
  const settings = await storage.get('settings');
  const months = windowMonths != null ? Number(windowMonths) : settings.defaultWindowMonths ?? 6;

  let cutoffISO = null;
  if (months > 0) {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    d.setHours(0, 0, 0, 0);
    cutoffISO = d.toISOString();
  }

  const history = await storage.get('history');
  const tabs = await chrome.tabs.query({ url: 'https://secure.ally.com/*' });
  if (!tabs.length) throw new Error('No Ally tab open — open your Ally transactions page first.');
  const tab = tabs.find((t) => t.active) || tabs[0];

  // Hand the walk to the content script; it streams capture/check back to us.
  return await chrome.tabs.sendMessage(tab.id, {
    type: 'capture/run',
    cutoffISO,
    processed: history.processed,
  });
}

async function onCheckCaptured({ record, stripB64 }) {
  if (!record || record.checkNumber == null) return;
  if (stripB64) await idb.putStrip(record.checkNumber, b64ToBlob(stripB64, 'image/png'));

  const list = await storage.get('dataset');
  if (!list.some((r) => r.checkNumber === record.checkNumber)) list.push(record);
  await storage.set('dataset', list);
  await storage.markProcessed(record.checkNumber);
}
