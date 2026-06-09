// Reconciliation engine — implements the user's "Check Merchant + Category
// Assignment" procedure spec against the Monarch MCP. The verified dataset is the
// source of truth; Monarch's "Ally Bank" / "Check Paid #NNNN" labels are never
// used to match or skip. Supports a dry-run (plan + log, write nothing).
import * as monarch from './monarch.js';
import * as storage from '../lib/storage.js';
import { normalize } from '../lib/normalize.js';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const amt = (a) => Math.abs(parseFloat(a) || 0);
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const isGeneric = (m) => !m || /^ally bank$/i.test(m.trim()) || /^check paid #/i.test(m.trim());

function windowAround(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  const s = new Date(d); s.setDate(d.getDate() - days);
  const e = new Date(d); e.setDate(d.getDate() + days);
  return { start: iso(s), end: iso(e) };
}
function progress(p) {
  // callback form + lastError so a closed UI doesn't leave an unhandled rejection
  try { chrome.runtime.sendMessage({ type: 'reconcile/progress', ...p }, () => void chrome.runtime.lastError); } catch {}
}
const txList = (r) => (r && Array.isArray(r.transactions) ? r.transactions : []);
const merList = (r) => (r && Array.isArray(r.merchants) ? r.merchants : []);

// Tiered location: check# → date+amount → flag.
async function locate(rec) {
  const w = windowAround(rec.date, 12);
  let txs = txList(await monarch.getTransactions({
    start_date: w.start, end_date: w.end,
    filters: { transaction_type: 'All', search: String(rec.checkNumber) },
  }));
  let m = txs.filter((t) => amt(t.amount) === amt(rec.amount));
  if (m.length === 1) return { tx: m[0], tier: 1 };
  if (m.length > 1) return { ambiguous: m, tier: 1 };

  txs = txList(await monarch.getTransactions({
    start_date: w.start, end_date: w.end, filters: { transaction_type: 'All' }, limit: 200,
  }));
  m = txs.filter((t) => amt(t.amount) === amt(rec.amount) && t.date === rec.date);
  if (m.length === 1) return { tx: m[0], tier: 2 };
  if (m.length > 1) return { ambiguous: m, tier: 2 };
  return { notFound: true };
}

async function resolveMerchant(canonical, dryRun) {
  const ms = merList(await monarch.getMerchants(canonical, 50));
  const exact = ms.find((m) => norm(m.name) === norm(canonical));
  if (exact) return { merchant_id: exact.merchant_id, created: false };
  if (dryRun) return { merchant_id: null, created: true, wouldCreate: canonical };
  const c = await monarch.createMerchant(canonical);
  const id = c && (c.merchant_id || (c.merchant && c.merchant.merchant_id));
  return { merchant_id: id, created: true };
}

// Category from the merchant's existing transactions: uniform / dominant / none.
async function deriveCategory(merchantName) {
  const now = new Date();
  const start = new Date(now); start.setFullYear(now.getFullYear() - 2);
  const txs = txList(await monarch.getTransactions({
    start_date: iso(start), end_date: iso(now),
    filters: { transaction_type: 'All', search: merchantName }, limit: 100,
  })).filter((t) => norm(t.merchant) === norm(merchantName) && t.category_id);
  if (!txs.length) return { category_id: null, source: 'none' };
  const counts = {};
  const nameById = {};
  for (const t of txs) { counts[t.category_id] = (counts[t.category_id] || 0) + 1; nameById[t.category_id] = t.category; }
  const ids = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return { category_id: ids[0], categoryName: nameById[ids[0]], source: ids.length === 1 ? 'uniform' : 'dominant' };
}

export async function run({ dryRun }) {
  const map = await storage.get('normalizationMap');
  const dataset = await storage.get('dataset');
  const checks = dataset.filter((r) => r.recipient); // can't assign without a recipient
  const log = [];
  const touched = new Set();

  for (let i = 0; i < checks.length; i++) {
    const rec = checks[i];
    const canonical = normalize(rec.recipient, map);
    const e = { checkNumber: rec.checkNumber, date: rec.date, amount: rec.amount, recipient: canonical };
    progress({ phase: 'check', i: i + 1, total: checks.length, checkNumber: rec.checkNumber });

    let loc;
    try { loc = await locate(rec); }
    catch (err) { e.status = 'flagged'; e.flagReason = 'locate error: ' + err.message; log.push(e); progress({ entry: e }); continue; }
    if (loc.notFound) { e.status = 'flagged'; e.flagReason = 'transaction not found'; log.push(e); progress({ entry: e }); continue; }
    if (loc.ambiguous) { e.status = 'flagged'; e.flagReason = `ambiguous (${loc.ambiguous.length} same amount/date)`; log.push(e); progress({ entry: e }); continue; }

    const tx = loc.tx;
    e.transaction_id = tx.id; e.tier = loc.tier; e.currentMerchant = tx.merchant;

    if (!isGeneric(tx.merchant) && norm(tx.merchant) === norm(canonical)) {
      e.status = 'skipped'; e.flagReason = 'already assigned'; e.merchant_id = tx.merchant_id;
      log.push(e); progress({ entry: e }); continue;
    }

    let mr;
    try { mr = await resolveMerchant(canonical, dryRun); }
    catch (err) { e.status = 'flagged'; e.flagReason = 'merchant resolve: ' + err.message; log.push(e); progress({ entry: e }); continue; }
    e.merchant_id = mr.merchant_id; e.merchantCreated = mr.created;
    touched.add(canonical);

    let cat = { category_id: null, source: 'unchanged' };
    if (!tx.category_id || isGeneric(tx.merchant)) {
      try { cat = await deriveCategory(canonical); } catch { cat = { category_id: null, source: 'error' }; }
    }
    e.category_id = cat.category_id; e.categorySource = cat.source; if (cat.categoryName) e.category = cat.categoryName;
    if (cat.source === 'none') e.flag = 'new merchant — no category signal';
    if (cat.source === 'dominant') e.flag = 'mixed category — used dominant';

    const fields = {};
    if (mr.merchant_id) fields.merchant_id = mr.merchant_id;
    if (cat.category_id) fields.category_id = cat.category_id;

    if (dryRun) {
      e.status = mr.wouldCreate ? 'would-write (create merchant)' : 'would-write';
      e.fields = fields;
      log.push(e); progress({ entry: e }); continue;
    }
    if (!mr.merchant_id) { e.status = 'flagged'; e.flagReason = 'no merchant id'; log.push(e); progress({ entry: e }); continue; }
    try {
      await monarch.updateTransaction(tx.id, fields);
      const w = windowAround(rec.date, 12);
      const vt = txList(await monarch.getTransactions({
        start_date: w.start, end_date: w.end,
        filters: { transaction_type: 'All', search: String(rec.checkNumber) },
      })).find((t) => t.id === tx.id);
      e.status = vt && vt.merchant_id === mr.merchant_id ? 'written' : 'written (unverified)';
    } catch (err) { e.status = 'flagged'; e.flagReason = 'write failed: ' + err.message; }
    log.push(e); progress({ entry: e });
  }

  // End-of-run duplicate-merchant sweep for every payee touched.
  const merges = [];
  for (const canonical of touched) {
    try {
      const ms = merList(await monarch.getMerchants(canonical, 50)).filter((m) => norm(m.name) === norm(canonical));
      if (ms.length > 1) {
        ms.sort((a, b) => (b.transaction_count || 0) - (a.transaction_count || 0));
        const target = ms[0].merchant_id;
        const sources = ms.slice(1).map((m) => m.merchant_id);
        if (dryRun) merges.push({ canonical, target, sources, dryRun: true });
        else { await monarch.mergeMerchants(sources, target); merges.push({ canonical, target, sources }); }
      }
    } catch {}
  }

  await storage.set('runLog', log);
  return { log, merges, dryRun };
}
