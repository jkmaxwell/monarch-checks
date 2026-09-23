// Service worker: message router + capture orchestration. All cross-origin
// fetches (Anthropic, Monarch) will live here (CORS bypassed via host_permissions).
// ES module.
import * as storage from '../lib/storage.js';
import * as idb from '../lib/idb.js';
import { b64ToBlob, b64FromBlob } from '../lib/util.js';
import { bank } from '../lib/banks.js';
import { extractRecipient } from './anthropic.js';
import * as mcp from './mcp-client.js';
import * as monarch from './monarch.js';
import * as reconcile from './reconcile.js';

chrome.runtime.onInstalled.addListener(() => console.log('Ally Checks installed'));

// Reconcile runs entirely inside this worker, so a fresh worker means any run
// marked active died with the old one (terminated mid-run). Clear it, or the
// review page shows "Reconciling…" forever with the buttons disabled.
(async () => {
  const rs = await storage.get('runState');
  if (rs && rs.active === 'reconcile') await storage.set('runState', { ...rs, active: null });
})();

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
    case 'merchants/search':
      return await searchMerchants(msg);
    case 'status/get':
      return await storage.get('runState');
    case 'runlog/get':
      return await storage.get('runLog');
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
      type: 'reconcile/done', dryRun, error: res.error,
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
  const b = bank(settings.bank);
  const tabs = await chrome.tabs.query({ url: b.tabMatch });
  if (!tabs.length) throw new Error(`No ${b.label} tab open — open your ${b.label} transactions page first.`);
  const tab = tabs.find((t) => t.active) || tabs[0];

  // Ensure the content script is present (it won't be in tabs that were already
  // open when the extension loaded). Injecting is idempotent — the script guards
  // re-injection with a window flag.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [b.captureScript] });
  } catch (e) {
    throw new Error(`Could not inject into the ${b.label} tab: ` + ((e && e.message) || e));
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
  try { await idb.clearFulls(); } catch {}
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
  // Full images too, so bad-crop recovery survives a wipe. They're JPEG, but they
  // still dominate backup size — the biggest part of the file by far.
  const fulls = {};
  for (const [n, blob] of Object.entries(await idb.allFulls())) {
    fulls[n] = await b64FromBlob(blob);
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    dataset: await storage.get('dataset'),
    history: await storage.get('history'),
    normalizationMap: await storage.get('normalizationMap'),
    merchantIdMap: await storage.get('merchantIdMap'),
    runLog: await storage.get('runLog'),
    strips,
    fulls,
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
  if (snapshot.merchantIdMap) await storage.set('merchantIdMap', snapshot.merchantIdMap);
  if (snapshot.runLog) await storage.set('runLog', snapshot.runLog);
  let strips = 0;
  for (const [n, b64] of Object.entries(snapshot.strips || {})) {
    await idb.putStrip(n, b64ToBlob(b64, 'image/png'));
    strips++;
  }
  for (const [n, b64] of Object.entries(snapshot.fulls || {})) {
    await idb.putFull(n, b64ToBlob(b64, 'image/jpeg'));
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

async function onCheckCaptured({ record, stripB64, fullB64 }) {
  if (!record || record.checkNumber == null) return;
  if (stripB64) await idb.putStrip(record.checkNumber, b64ToBlob(stripB64, 'image/png'));
  if (fullB64) await idb.putFull(record.checkNumber, b64ToBlob(fullB64, 'image/jpeg'));

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
  // Merchant search exists on the official MCP only.
  const merchants = rec.recipient && !(await monarch.isLocal()) ? await monarch.getMerchants(rec.recipient, 10) : null;
  return { check: rec, txByNumber, merchants };
}

async function setRecipient({ checkNumber, recipient, confidence, original, merchantId }) {
  const list = await storage.get('dataset');
  const r = list.find((x) => String(x.checkNumber) === String(checkNumber));
  const clean = String(recipient || '').trim();
  if (r) {
    // If this edit changes what was reconciled, drop the stamp so the check
    // returns to the review queue (a genuine reason to re-verify + re-push).
    if (r.reconciled && (r.reconciled.recipient !== clean || (r.reconciled.merchant_id || null) !== (merchantId || null))) {
      delete r.reconciled;
    }
    r.recipient = clean;
    r.confidence = confidence || 'high'; // user-verified
    if (merchantId) r.merchantId = merchantId; else delete r.merchantId;
    await storage.set('dataset', list);
  }
  // Learn the OCR→correction alias so the same misread self-corrects next time.
  const from = String(original || '').trim();
  if (from && clean && from.toLowerCase() !== clean.toLowerCase()) {
    const map = await storage.get('normalizationMap');
    map[from] = clean;
    await storage.set('normalizationMap', map);
  }
  // Remember the canonical name → Monarch merchant id so reconcile assigns by id.
  if (clean && merchantId) {
    const idMap = await storage.get('merchantIdMap');
    idMap[clean] = merchantId;
    await storage.set('merchantIdMap', idMap);
  }
  // Editing a recipient IS the human confirming the name — the full image (kept
  // only to read a missed crop) is no longer needed. Drop it; the strip stays.
  if (clean) { try { await idb.deleteFull(checkNumber); } catch {} }
  return { ok: true };
}

// Merchant-name suggestions for the review autocomplete. Official MCP only —
// local mode has no merchant search (returns []), and an unconnected/erroring
// Monarch also returns [] so the UI just falls back to corrected-name history.
async function searchMerchants({ query } = {}) {
  try {
    if (await monarch.isLocal()) return { merchants: [] };
    const resp = await monarch.getMerchants(query || null, 100);
    const list = Array.isArray(resp && resp.merchants) ? resp.merchants : [];
    return { merchants: list.map((m) => ({ name: m.name, merchant_id: m.merchant_id })) };
  } catch (e) {
    return { merchants: [], error: String((e && e.message) || e) };
  }
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
