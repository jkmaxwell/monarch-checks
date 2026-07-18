// Service worker: message router + capture orchestration. All cross-origin
// fetches (Anthropic, Monarch) will live here (CORS bypassed via host_permissions).
// ES module.
import * as storage from '../lib/storage.js';
import * as idb from '../lib/idb.js';
import { b64ToBlob, b64FromBlob } from '../lib/util.js';
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
    case 'status/get':
      return await storage.get('runState');
    case 'data/reset':
      return await resetData();
    case 'data/export':
      return await exportData();
    case 'data/import':
      return await importData(msg.snapshot);

    case 'capture/recheck':
      return await recheckOne(msg); // drop a check so the next capture re-fetches it
    case 'capture/start':
      startCaptureDetached(msg); // detached; content script broadcasts capture/done
      return { started: true };
    case 'capture/check':
      await onCheckCaptured(msg);
      await bumpRun((await storage.get('dataset')).length);
      return { ok: true };
    case 'capture/progress':
      return { ok: true };
    case 'capture/heartbeat':
      await bumpRun();
      return { ok: true };
    case 'capture/done':
      await setRun(null); // clears even if the SW restarted mid-capture
      return { ok: true };

    case 'extract/start':
      startExtractDetached(); // detached; broadcasts extract/done
      return { started: true };

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
      startReconcile(!!msg.dryRun); // detached; streams progress + a done broadcast
      return { started: true };

    default:
      return { error: 'unknown message: ' + msg?.type };
  }
}

// Run-state so the popup can show whether a long op is active + a heartbeat.
async function setRun(active) {
  const rs = await storage.get('runState');
  await storage.set('runState', { active, count: rs.count || 0, lastActivityAt: Date.now() });
}
async function bumpRun(count) {
  const rs = await storage.get('runState');
  rs.lastActivityAt = Date.now();
  if (count != null) rs.count = count;
  await storage.set('runState', rs);
}

// Safe broadcast: when no page is listening (popup/review closed),
// chrome.runtime.sendMessage rejects with "receiving end does not exist" — using
// the callback form and consuming lastError swallows it.
function broadcast(msg) {
  try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch {}
}

// Keep the MV3 service worker alive during long runs (each API call resets the
// ~30s idle timer); in-flight fetches help too, this covers the gaps.
let keepAliveTimer = null;
function keepAlive(on) {
  if (on) {
    if (!keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  } else if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// Run reconcile detached from the request channel; broadcast progress + a final
// 'reconcile/done' so the UI doesn't depend on a long-held sendResponse.
async function startReconcile(dryRun) {
  keepAlive(true);
  await setRun('reconcile');
  try {
    const res = await reconcile.run({ dryRun });
    const log = res.log || [];
    const count = (s) => log.filter((e) => (e.status || '').startsWith(s)).length;
    broadcast({
      type: 'reconcile/done', dryRun,
      written: count('written'), would: count('would'), skipped: count('skipped'),
      flagged: count('flagged'), merges: (res.merges || []).length,
    });
  } catch (e) {
    broadcast({ type: 'reconcile/done', dryRun, error: String((e && e.message) || e) });
  } finally {
    await setRun(null);
    keepAlive(false);
  }
}

async function startCaptureDetached(msg) {
  keepAlive(true);
  await setRun('capture');
  try {
    await startCapture(msg);
  } catch (e) {
    broadcast({ type: 'capture/done', captured: 0, error: String((e && e.message) || e) });
  } finally {
    await setRun(null);
    keepAlive(false);
  }
}

async function startExtractDetached() {
  keepAlive(true);
  await setRun('extract');
  try {
    const res = await runExtract();
    broadcast({ type: 'extract/done', extracted: res.extracted });
  } catch (e) {
    broadcast({ type: 'extract/done', extracted: 0, error: String((e && e.message) || e) });
  } finally {
    await setRun(null);
    keepAlive(false);
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

// Wipe captured checks/strips/history to start clean. Keeps settings, the Monarch
// connection, and the normalization map.
async function resetData() {
  await storage.set('dataset', []);
  await storage.set('history', { processed: [], newestCheckNumber: null });
  await storage.set('runState', { active: null, count: 0, lastActivityAt: 0 });
  try { await idb.clearStrips(); } catch {}
  return { ok: true };
}

// Backup: everything needed to survive the browser dropping the extension
// (Dia wipes unpacked extensions on some updates, deleting storage + IDB with
// them). Excludes settings (API key) and the Monarch tokens on purpose.
async function exportData() {
  const strips = {};
  for (const [n, blob] of Object.entries(await idb.allStrips())) {
    strips[n] = await b64FromBlob(blob);
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    dataset: await storage.get('dataset'),
    history: await storage.get('history'),
    normalizationMap: await storage.get('normalizationMap'),
    runLog: await storage.get('runLog'),
    strips,
  };
}

// Restore a backup. Replaces dataset/history/map/log wholesale (restore
// semantics, not merge) and re-populates the strip store.
async function importData(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.dataset)) {
    throw new Error('Not an Ally Checks backup file.');
  }
  await storage.set('dataset', snapshot.dataset);
  await storage.set('history', snapshot.history || { processed: [], newestCheckNumber: null });
  if (snapshot.normalizationMap) await storage.set('normalizationMap', snapshot.normalizationMap);
  if (snapshot.runLog) await storage.set('runLog', snapshot.runLog);
  let strips = 0;
  for (const [n, b64] of Object.entries(snapshot.strips || {})) {
    await idb.putStrip(n, b64ToBlob(b64, 'image/png'));
    strips++;
  }
  return { ok: true, checks: snapshot.dataset.length, strips };
}

// Remove a check from dedup history + dataset so a subsequent capture re-fetches
// and re-crops it (its strip is overwritten; recipient resets so Extract re-reads).
async function recheckOne({ checkNumber }) {
  const n = String(checkNumber);
  const h = await storage.get('history');
  h.processed = h.processed.filter((x) => x !== n);
  await storage.set('history', h);
  const ds = await storage.get('dataset');
  await storage.set('dataset', ds.filter((r) => String(r.checkNumber) !== n));
  return { ok: true, removed: n };
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
  let consecutiveErrors = 0;
  let lastErr = null;
  for (const r of todo) {
    const strip = await idb.getStrip(r.checkNumber);
    if (!strip) { r.confidence = 'low'; continue; }
    try {
      const res = await extractRecipient(strip, settings.anthropicApiKey);
      r.recipient = res.recipient;
      r.confidence = res.confidence;
      consecutiveErrors = 0;
    } catch (e) {
      r.recipient = '';
      r.confidence = 'low';
      r.extractError = String((e && e.message) || e);
      lastErr = r.extractError;
      consecutiveErrors++;
    }
    done++;
    await storage.set('dataset', list); // checkpoint each
    await bumpRun();
    broadcast({
      type: 'extract/progress', done, total: todo.length,
      checkNumber: r.checkNumber, recipient: r.recipient, confidence: r.confidence,
    });
    // A bad key or rate limit fails every call — stop instead of marking the
    // whole backlog low-confidence. Untouched checks retry next run.
    if (consecutiveErrors >= 3) {
      throw new Error(`stopped after 3 consecutive extract errors (last: ${lastErr}); extracted ${done - 3} first`);
    }
  }
  return { extracted: done };
}
