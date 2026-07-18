// High-level Monarch operations over the MCP client, speaking either the
// official Monarch MCP (OAuth; hides Plaid-connected accounts) or a local
// robcerda/monarch-mcp-server over streamable HTTP (keyring session; sees every
// account, Plaid included). Both return their payload as a STRING (JSON) inside
// the MCP content, so we unwrap + JSON.parse defensively.
import { callTool, mcpConfig } from './mcp-client.js';

function unwrap(res) {
  if (res && res.structuredContent && 'result' in res.structuredContent) return res.structuredContent.result;
  const t = res && Array.isArray(res.content) ? res.content.find((c) => c.type === 'text') : null;
  return t ? t.text : null;
}
export function parse(res) {
  const raw = unwrap(res);
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}
// The local server reports failures as a SUCCESSFUL tool result with
// {error:true, message} — surface those as real errors.
function parsed(res, tool) {
  const p = parse(res);
  if (p && p.error) throw new Error(tool + ': ' + (p.message || 'server error'));
  return p;
}

export async function isLocal() { return (await mcpConfig()).mode === 'local'; }

const asFilters = (f) => (typeof f === 'string' ? f : JSON.stringify(f || { transaction_type: 'All' }));

export async function getTransactions({ start_date, end_date, filters, limit = 100, include_details = false }) {
  if (await isLocal()) {
    const f = typeof filters === 'string' ? JSON.parse(filters) : (filters || {});
    const r = parsed(await callTool('get_transactions', {
      start_date, end_date, limit,
      ...(f.search != null ? { search: String(f.search) } : {}),
    }), 'get_transactions');
    // Local envelope {data, total_count} → the official's {transactions,
    // transaction_count} shape reconcile already consumes. Rows carry the same
    // keys we use (id, date, amount, merchant, category_id); merchant_id is
    // absent — local mode assigns merchants by name.
    return { transactions: (r && (r.data || r.results)) || [], transaction_count: r ? r.total_count : null };
  }
  return parse(await callTool('GetTransactions', {
    start_date, end_date, filters: asFilters(filters), limit, include_details,
  }));
}
// Official-MCP-only: the local server has no merchant search/create/merge —
// in local mode merchants are assigned by NAME via update_transaction, and
// Monarch links-or-creates (and thereby dedupes) server-side.
export async function getMerchants(search, limit = 100) {
  return parse(await callTool('GetMerchants', { search: search ?? null, limit }));
}
export async function createMerchant(name) {
  return parse(await callTool('CreateMerchant', { name }));
}
export async function mergeMerchants(sourceIds, targetId) {
  return parse(await callTool('MergeMerchants', { source_merchant_ids: sourceIds, target_merchant_id: targetId }));
}
export async function getCategories() {
  if (await isLocal()) return parsed(await callTool('get_categories', {}), 'get_categories');
  return parse(await callTool('GetCategories', {}));
}
// fields: {merchant_id?, category_id?} official; {merchant_name?, category_id?} local.
export async function updateTransaction(transaction_id, fields) {
  if (await isLocal()) {
    return parsed(await callTool('update_transaction', { transaction_id, ...fields }), 'update_transaction');
  }
  return parse(await callTool('UpdateTransaction', { transaction_id, ...fields }));
}
