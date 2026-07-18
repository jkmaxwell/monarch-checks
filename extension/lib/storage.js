// Typed wrappers over chrome.storage.local (ES module).
const DEFAULTS = {
  settings: {
    anthropicApiKey: '',
    defaultWindowMonths: 6,
    mcpMode: 'local', // 'local' (robcerda/monarch-mcp-server) | 'official' (OAuth)
    mcpLocalUrl: 'http://127.0.0.1:8642/mcp',
  },
  history: { processed: [], newestCheckNumber: null },
  // Payee-name fixups ({ misread → canonical }). Personal entries live in
  // chrome.storage / backups only — never seed real names in source.
  normalizationMap: {},
  monarchAuth: null, // { clientId, accessToken, refreshToken, expiresAt, scopes }
  runLog: [],
  dataset: [], // working per-check records (accumulates across runs, deduped by checkNumber)
  runState: { active: null, count: 0, lastActivityAt: 0 }, // active: 'capture'|'extract'|'reconcile'|null
};

export async function get(key) {
  const out = await chrome.storage.local.get(key);
  return key in out ? out[key] : structuredClone(DEFAULTS[key]);
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function patch(key, partial) {
  const cur = await get(key);
  const next = { ...cur, ...partial };
  await set(key, next);
  return next;
}

// History dedup helpers.
export async function isProcessed(checkNumber) {
  const h = await get('history');
  return h.processed.includes(String(checkNumber));
}

export async function markProcessed(checkNumber) {
  const h = await get('history');
  const n = String(checkNumber);
  if (!h.processed.includes(n)) h.processed.push(n);
  await set('history', h);
}
