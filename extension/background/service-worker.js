// Service worker: message router + capture orchestration. All cross-origin
// fetches (Anthropic, Monarch) will live here (CORS bypassed via host_permissions).
// ES module.
import * as storage from '../lib/storage.js';
import * as idb from '../lib/idb.js';
import { b64ToBlob } from '../lib/util.js';
import { extractRecipient } from './anthropic.js';
import * as mcp from './mcp-client.js';
import * as monarch from './monarch.js';
import * as reconcile from './reconcile.js';

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
    case 'dataset/setRecipient':
      return await setRecipient(msg);

    case 'capture/start':
      return await startCapture(msg);
    case 'capture/check':
      await onCheckCaptured(msg);
      return { ok: true };
    case 'capture/progress':
    case 'capture/done':
      return { ok: true }; // dashboard listens to these for UI; SW persists via capture/check

    case 'extract/start':
      return await runExtract();

    case 'monarch/connect':
      return await mcp.connect();
    case 'monarch/status':
      return await mcp.status();
    case 'monarch/revoke':
      return await mcp.revoke();
    case 'monarch/tools':
      return await mcp.listTools();
    case 'monarch/probe':
      return await probeMonarch(msg);
    case 'reconcile/run':
      return await reconcile.run({ dryRun: !!msg.dryRun });

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

  // Ensure the content script is present (it won't be in tabs that were already
  // open when the extension loaded). Injecting is idempotent — the script guards
  // re-injection with a window flag.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/ally-capture.js'] });
  } catch (e) {
    throw new Error('Could not inject into the Ally tab: ' + ((e && e.message) || e));
  }

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

// Probe Monarch to reveal the real transaction/merchant result shapes (used to
// finalize the reconcile parsing). Reads only; writes nothing.
async function probeMonarch({ checkNumber }) {
  const ds = await storage.get('dataset');
  const rec = checkNumber ? ds.find((r) => String(r.checkNumber) === String(checkNumber)) : ds[ds.length - 1];
  if (!rec) throw new Error('No dataset record to probe — capture some checks first.');
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const d = new Date(rec.date + 'T00:00:00');
  const start = new Date(d); start.setDate(d.getDate() - 10);
  const end = new Date(d); end.setDate(d.getDate() + 10);

  const txByNumber = await monarch.getTransactions({
    start_date: iso(start), end_date: iso(end),
    filters: { transaction_type: 'All', search: String(rec.checkNumber) },
    include_details: true,
  });
  const merchants = await monarch.getMerchants(rec.recipient || 'Jane Doe', 10);
  return { check: rec, txByNumber, merchants };
}

async function setRecipient({ checkNumber, recipient, confidence }) {
  const list = await storage.get('dataset');
  const r = list.find((x) => String(x.checkNumber) === String(checkNumber));
  if (r) {
    r.recipient = String(recipient || '').trim();
    r.confidence = confidence || 'high'; // user-verified
    await storage.set('dataset', list);
  }
  return { ok: true };
}

// Phase 2: extract recipients for dataset records that don't have one yet.
async function runExtract() {
  const settings = await storage.get('settings');
  if (!settings.anthropicApiKey) throw new Error('Set your Claude API key in Settings first.');
  const list = await storage.get('dataset');
  const todo = list.filter((r) => !r.recipient);
  let done = 0;
  for (const r of todo) {
    const strip = await idb.getStrip(r.checkNumber);
    if (!strip) { r.confidence = 'low'; continue; }
    try {
      const res = await extractRecipient(strip, settings.anthropicApiKey);
      r.recipient = res.recipient;
      r.confidence = res.confidence;
    } catch (e) {
      r.recipient = '';
      r.confidence = 'low';
      r.extractError = String((e && e.message) || e);
    }
    done++;
    await storage.set('dataset', list); // checkpoint each
    chrome.runtime.sendMessage({
      type: 'extract/progress', done, total: todo.length,
      checkNumber: r.checkNumber, recipient: r.recipient, confidence: r.confidence,
    });
  }
  return { extracted: done };
}
