// High-level Monarch operations over the MCP client. Monarch's tools return
// their payload as a STRING (LLM-formatted JSON) wrapped per fastmcp, so we
// unwrap + JSON.parse defensively. Tool names/params per the live tools/list.
import { callTool } from './mcp-client.js';

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

const asFilters = (f) => (typeof f === 'string' ? f : JSON.stringify(f || { transaction_type: 'All' }));

export async function getTransactions({ start_date, end_date, filters, limit = 100, include_details = false }) {
  return parse(await callTool('GetTransactions', {
    start_date, end_date, filters: asFilters(filters), limit, include_details,
  }));
}
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
  return parse(await callTool('GetCategories', {}));
}
export async function updateTransaction(transaction_id, fields) {
  return parse(await callTool('UpdateTransaction', { transaction_id, ...fields }));
}
