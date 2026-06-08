// Typed wrappers over chrome.storage.local (ES module).
const DEFAULTS = {
  settings: { anthropicApiKey: '', defaultWindowMonths: 6 },
  history: { processed: [], newestCheckNumber: null },
  normalizationMap: {
    'Jayne Doe': 'Jane Doe',
    'Acme Landscaping': 'Acme Landscaping Co',
    'Example Flooring and Supply Inc': 'Example Flooring & Supply Inc',
  },
  monarchAuth: null, // { clientId, accessToken, refreshToken, expiresAt, scopes }
  runLog: [],
  dataset: [], // working per-check records (accumulates across runs, deduped by checkNumber)
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
