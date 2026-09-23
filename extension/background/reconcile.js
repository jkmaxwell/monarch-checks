// Reconciliation engine — implements the user's "Check Merchant + Category
// Assignment" procedure spec against the Monarch MCP. The verified dataset is the
// source of truth; Monarch's "Ally Bank" / "Check Paid #NNNN" labels are never
// used to match or skip. Supports a dry-run (plan + log, write nothing).
import * as monarch from './monarch.js';
import * as storage from '../lib/storage.js';
import * as idb from '../lib/idb.js';
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
// Monarch's MCP excludes Plaid-connected accounts: matching transactions are
// counted but not returned (`plaid_excluded` block in the response). Without
// this check they'd all be misreported as "transaction not found".
const plaidHidden = (r) =>
  Boolean(r && r.plaid_excluded && (r.plaid_excluded.hidden_account_count || 0) > 0);

// Tiered location: check# → date+amount → flag.
async function locate(rec) {
  const w = windowAround(rec.date, 12);
  let resp = await monarch.getTransactions({
    start_date: w.start, end_date: w.end,
    filters: { transaction_type: 'All', search: String(rec.checkNumber) },
  });
  let m = txList(resp).filter((t) => amt(t.amount) === amt(rec.amount));
  if (m.length === 1) return { tx: m[0], tier: 1 };
  if (m.length > 1) return { ambiguous: m, tier: 1 };
  if (plaidHidden(resp)) return { hidden: true };

  resp = await monarch.getTransactions({
    start_date: w.start, end_date: w.end, filters: { transaction_type: 'All' }, limit: 200,
  });
  m = txList(resp).filter((t) => amt(t.amount) === amt(rec.amount) && t.date === rec.date);
  if (m.length === 1) return { tx: m[0], tier: 2 };
  if (m.length > 1) return { ambiguous: m, tier: 2 };
  if (plaidHidden(resp)) return { hidden: true };
  return { notFound: true };
}

async function resolveMerchant(canonical, dryRun, knownId) {
  // A review correction that selected a real Monarch merchant already gave us
  // the id — assign by it directly, no name search (which drifts / dupes).
  if (knownId) return { merchant_id: knownId, created: false };
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

// Learn a mapping discovered from Monarch itself: the check's OCR name (fromName)
// resolves to the merchant the user assigned in Monarch (monarchName + id). Lets
// future checks with the same OCR spelling skip straight to their merchant.
async function learnFromMonarch(fromName, monarchName, merchantId) {
  const from = String(fromName || '').trim();
  const to = String(monarchName || '').trim();
  if (from && to && from.toLowerCase() !== to.toLowerCase()) {
    const map = await storage.get('normalizationMap');
    map[from] = to;
    await storage.set('normalizationMap', map);
  }
  if (to && merchantId) {
    const idMap = await storage.get('merchantIdMap');
    idMap[to] = merchantId;
    await storage.set('merchantIdMap', idMap);
  }
}

export async function run({ dryRun }) {
  // Local mode (robcerda/monarch-mcp-server): no merchant search/create/merge
  // tools — merchants are assigned by NAME on update_transaction and Monarch
  // links-or-creates server-side, so the resolve and merge steps don't apply.
  const local = await monarch.isLocal();
  const map = await storage.get('normalizationMap');
  const idMap = await storage.get('merchantIdMap');
  const dataset = await storage.get('dataset');
  const checks = dataset.filter((r) => r.recipient); // can't assign without a recipient
  const log = [];
  const touched = new Set();
  let hiddenCount = 0;
  let fatal = null; // 401/429 from Monarch: every later call fails the same way — stop
  // Persist progress as it happens (log after every entry, position in
  // runState) so the review page can poll it — broadcasts alone are lost when
  // Dia discards or reloads the tab mid-run.
  const emit = async (entry) => { log.push(entry); progress({ entry }); await storage.set('runLog', log); };
  // Persist a per-check reconciliation stamp so the review page can drop settled
  // checks out of the review queue (and resurface them only if edited later). Not
  // in dry-run — that mode writes nothing, local or Monarch.
  let stampedAny = false;
  const dropFull = []; // full images to delete once synced (audit no longer needed)
  const stampReconciled = (rec, e) => {
    if (dryRun) return;
    rec.reconciled = { at: Date.now(), transactionId: e.transaction_id || null, merchant_id: e.merchant_id || null, recipient: e.recipient };
    stampedAny = true;
    dropFull.push(rec.checkNumber);
  };
  await storage.set('runLog', []);
  await storage.patch('runState', { dryRun: Boolean(dryRun), total: checks.length, i: 0, checkNumber: null });

  for (let i = 0; i < checks.length; i++) {
    const rec = checks[i];
    const canonical = normalize(rec.recipient, map);
    const e = { checkNumber: rec.checkNumber, date: rec.date, amount: rec.amount, recipient: canonical };
    progress({ phase: 'check', i: i + 1, total: checks.length, checkNumber: rec.checkNumber });
    await storage.patch('runState', { i: i + 1, checkNumber: rec.checkNumber, lastActivityAt: Date.now() });

    let loc;
    try { loc = await locate(rec); }
    catch (err) {
      e.status = 'flagged'; e.flagReason = 'locate error: ' + err.message; await emit(e);
      // Grinding on after an auth failure or rate limit just burns more requests
      // (and a 429 storm can get the session revoked) — stop the run here.
      if (/\b401\b|Unauthorized/.test(err.message)) {
        fatal = 'Monarch rejected the saved login (401). Re-run login_setup.py in monarch-mcp-server, then reconcile again.';
        break;
      }
      if (/\b429\b|Too Many Requests/.test(err.message)) {
        fatal = 'Monarch is rate-limiting (429). Wait ~30 minutes before reconciling again.';
        break;
      }
      continue;
    }
    if (loc.hidden) {
      e.status = 'flagged'; e.flagReason = 'in Monarch, but its MCP hides Plaid-connected accounts';
      await emit(e);
      // Every check is on the same (hidden) account — stop instead of grinding
      // through the rest. The fix is Monarch-side: migrate off Plaid.
      if (++hiddenCount >= 3) {
        await storage.set('runLog', log);
        return {
          log, merges: [], dryRun,
          error: "Monarch's MCP can't see Plaid-connected accounts, which currently includes Ally. " +
            'Migrate the connection at app.monarchmoney.com/accounts?reconnect=plaid_migration, then re-run.',
        };
      }
      continue;
    }
    if (loc.notFound) { e.status = 'flagged'; e.flagReason = 'transaction not found'; await emit(e); continue; }
    if (loc.ambiguous) { e.status = 'flagged'; e.flagReason = `ambiguous (${loc.ambiguous.length} same amount/date)`; await emit(e); continue; }

    const tx = loc.tx;
    e.transaction_id = tx.id; e.tier = loc.tier; e.currentMerchant = tx.merchant;

    if (!isGeneric(tx.merchant)) {
      // A real merchant is already on this transaction. If it matches our name,
      // it's done. If it DIFFERS, the user assigned it in Monarch — their edit
      // wins, never overwrite it. Learn the OCR→merchant mapping so this spelling
      // resolves straight to their merchant next time. Either way: settled.
      e.merchant_id = tx.merchant_id;
      if (norm(tx.merchant) === norm(canonical)) {
        e.status = 'skipped'; e.flagReason = 'already assigned';
      } else {
        e.status = 'skipped'; e.flagReason = `kept your Monarch merchant (${tx.merchant})`;
        if (!dryRun) await learnFromMonarch(canonical, tx.merchant, tx.merchant_id);
      }
      stampReconciled(rec, e); // correctly in Monarch already — treat as settled
      await emit(e); continue;
    }

    let mr = { merchant_id: null, created: false };
    if (!local) {
      try { mr = await resolveMerchant(canonical, dryRun, rec.merchantId || idMap[canonical]); }
      catch (err) { e.status = 'flagged'; e.flagReason = 'merchant resolve: ' + err.message; await emit(e); continue; }
      e.merchant_id = mr.merchant_id; e.merchantCreated = mr.created;
    }
    touched.add(canonical);

    let cat = { category_id: null, source: 'unchanged' };
    if (!tx.category_id || isGeneric(tx.merchant)) {
      try { cat = await deriveCategory(canonical); } catch { cat = { category_id: null, source: 'error' }; }
    }
    e.category_id = cat.category_id; e.categorySource = cat.source; if (cat.categoryName) e.category = cat.categoryName;
    if (cat.source === 'none') e.flag = 'new merchant — no category signal';
    if (cat.source === 'dominant') e.flag = 'mixed category — used dominant';

    const fields = {};
    if (local) fields.merchant_name = canonical;
    else if (mr.merchant_id) fields.merchant_id = mr.merchant_id;
    if (cat.category_id) fields.category_id = cat.category_id;

    if (dryRun) {
      e.status = mr.wouldCreate ? 'would-write (create merchant)' : 'would-write';
      e.fields = fields;
      await emit(e); continue;
    }
    if (!local && !mr.merchant_id) { e.status = 'flagged'; e.flagReason = 'no merchant id'; await emit(e); continue; }
    try {
      await monarch.updateTransaction(tx.id, fields);
      const w = windowAround(rec.date, 12);
      const vt = txList(await monarch.getTransactions({
        start_date: w.start, end_date: w.end,
        filters: { transaction_type: 'All', search: String(rec.checkNumber) },
      })).find((t) => t.id === tx.id);
      // Verify by id (official) or by the assigned name (local, no merchant_id).
      const verified = local ? vt && norm(vt.merchant) === norm(canonical) : vt && vt.merchant_id === mr.merchant_id;
      e.status = verified ? 'written' : 'written (unverified)';
      stampReconciled(rec, e);
    } catch (err) { e.status = 'flagged'; e.flagReason = 'write failed: ' + err.message; }
    await emit(e);
  }

  // End-of-run duplicate-merchant sweep for every payee touched (official MCP
  // only — the local server assigns by name, which can't create duplicates).
  const merges = [];
  for (const canonical of local || fatal ? [] : touched) {
    try {
      const ms = merList(await monarch.getMerchants(canonical, 50)).filter((m) => norm(m.name) === norm(canonical));
      if (ms.length > 1) {
        ms.sort((a, b) => (b.transaction_count || 0) - (a.transaction_count || 0));
        const target = ms[0].merchant_id;
        const sources = ms.slice(1).map((m) => m.merchant_id);
        if (dryRun) merges.push({ canonical, target, sources, dryRun: true });
        else { await monarch.mergeMerchants(sources, target); merges.push({ canonical, target, sources }); }
      }
    } catch (err) {
      merges.push({ canonical, error: String((err && err.message) || err) });
    }
  }

  await storage.set('runLog', log);
  if (stampedAny) await storage.set('dataset', dataset); // persist reconciliation stamps
  // Drop full images for synced checks — the strip stays for reference; the full
  // was only for reading a missed crop pre-sync. Frees storage / shrinks backups.
  for (const n of dropFull) { try { await idb.deleteFull(n); } catch {} }
  return { log, merges, dryRun, ...(fatal ? { error: fatal } : {}) };
}
