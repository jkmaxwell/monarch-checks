// Monarch MCP client (service worker only). OAuth 2.1 + PKCE via dynamic client
// registration + chrome.identity.launchWebAuthFlow, then JSON-RPC over the
// Streamable-HTTP transport. Flow validated live against api.monarch.com.
import * as storage from '../lib/storage.js';
import { pkceChallenge, randomToken } from '../lib/util.js';

const MCP_URL = 'https://api.monarch.com/mcp';
const PRM_URL = 'https://api.monarch.com/.well-known/oauth-protected-resource/mcp';
const PROTOCOL_VERSION = '2025-06-18';

// host_permissions make Chrome attach the user's Monarch web-session cookies to
// these fetches; Django then rejects the chrome-extension:// Origin as CSRF
// (403 'Origin checking failed'). OAuth/MCP auth is Bearer-only — never send
// cookies.
const NO_COOKIES = { credentials: 'omit' };

// Which MCP to talk to. 'local' (default) is robcerda/monarch-mcp-server over
// streamable HTTP — no OAuth (it holds a Monarch session in its keyring) and,
// unlike the official MCP, it can see Plaid-connected accounts (= Ally).
// 'official' is the OAuth'd api.monarch.com MCP.
export async function mcpConfig() {
  const s = await storage.get('settings');
  return {
    mode: s.mcpMode || 'local',
    url: s.mcpLocalUrl || 'http://127.0.0.1:8642/mcp',
  };
}

let sessionId = null; // module-global; re-init if the SW restarted (sessionId null)
let sessionTarget = null; // invalidate the session when the mode/url changes

// ---- OAuth ----
async function discover() {
  const prm = await (await fetch(PRM_URL, NO_COOKIES)).json();
  const asBase = prm.authorization_servers[0].replace(/\/$/, '');
  const asm = await (await fetch(asBase + '/.well-known/oauth-authorization-server', NO_COOKIES)).json();
  return { resource: prm.resource, asm };
}

async function registerClient(asm) {
  const auth = await storage.get('monarchAuth');
  if (auth && auth.clientId) return auth.clientId;
  const resp = await fetch(asm.registration_endpoint, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [chrome.identity.getRedirectURL()],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp:read mcp:write',
      client_name: 'Ally Checks Extension',
    }),
  });
  if (!resp.ok) throw new Error('DCR failed: ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  const reg = await resp.json();
  await storage.patch('monarchAuth', { clientId: reg.client_id });
  return reg.client_id;
}

export async function connect() {
  const { resource, asm } = await discover();
  const clientId = await registerClient(asm);
  const redirect = chrome.identity.getRedirectURL();
  const { verifier, challenge } = await pkceChallenge();
  const state = randomToken(16);

  const url = new URL(asm.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirect,
    scope: 'mcp:read mcp:write', code_challenge: challenge, code_challenge_method: 'S256',
    state, resource,
  })) url.searchParams.set(k, v);

  const redirected = await chrome.identity.launchWebAuthFlow({ interactive: true, url: url.toString() });
  const ru = new URL(redirected);
  if (ru.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
  const code = ru.searchParams.get('code');
  if (!code) throw new Error('No authorization code: ' + (ru.searchParams.get('error') || 'unknown'));

  const tok = await fetch(asm.token_endpoint, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirect,
      client_id: clientId, code_verifier: verifier, resource,
    }),
  });
  if (!tok.ok) throw new Error('Token exchange failed: ' + tok.status + ' ' + (await tok.text()).slice(0, 200));
  const t = await tok.json();
  await storage.patch('monarchAuth', {
    accessToken: t.access_token, refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in || 3600) * 1000, scopes: t.scope,
    tokenEndpoint: asm.token_endpoint, resource,
  });
  sessionId = null;
  return { ok: true, scopes: t.scope };
}

export async function status() {
  const cfg = await mcpConfig();
  if (cfg.mode === 'local') return { mode: 'local', url: cfg.url };
  const auth = await storage.get('monarchAuth');
  return { mode: 'official', connected: Boolean(auth && auth.accessToken), scopes: auth && auth.scopes };
}

export async function revoke() {
  await storage.set('monarchAuth', null);
  sessionId = null;
  return { ok: true };
}

async function refresh(auth) {
  const tok = await fetch(auth.tokenEndpoint, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: auth.refreshToken,
      client_id: auth.clientId, resource: auth.resource,
    }),
  });
  if (!tok.ok) throw new Error('Token refresh failed: ' + tok.status);
  const t = await tok.json();
  return await storage.patch('monarchAuth', {
    accessToken: t.access_token, refreshToken: t.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
  });
}

async function accessToken() {
  let auth = await storage.get('monarchAuth');
  if (!auth || !auth.accessToken) throw new Error('Not connected to Monarch — connect in Settings.');
  if (auth.expiresAt && Date.now() > auth.expiresAt - 60000 && auth.refreshToken) auth = await refresh(auth);
  return auth.accessToken;
}

// ---- transport ----
function headers(token) {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  if (token) h.authorization = 'Bearer ' + token;
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  return h;
}

// Resolve the target for this call; a mode/url switch drops the MCP session.
async function target() {
  const cfg = await mcpConfig();
  const url = cfg.mode === 'local' ? cfg.url : MCP_URL;
  if (sessionTarget !== url) { sessionId = null; sessionTarget = url; }
  return { url, local: cfg.mode === 'local' };
}

function parseSse(text) {
  // SSE: events separated by a blank line; an event's data is the concatenation
  // of its `data:` lines. Handle CRLF or LF.
  let last = null;
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const dataLines = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (!dataLines.length) continue;
    try {
      const j = JSON.parse(dataLines.join('\n'));
      if (j && (j.result !== undefined || j.error !== undefined || j.id !== undefined)) last = j;
    } catch {}
  }
  if (!last) throw new Error('No JSON-RPC in SSE response: ' + text.slice(0, 200));
  return last;
}

async function rpc(method, params, retryAuth = true) {
  const t = await target();
  const token = t.local ? null : await accessToken();
  const resp = await fetch(t.url, {
    method: 'POST',
    credentials: 'omit',
    headers: headers(token),
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || {} }),
  }).catch((e) => {
    if (t.local) throw new Error(`Local MCP server unreachable at ${t.url} — start it with scripts/monarch-mcp-http.sh (${e.message})`);
    throw e;
  });
  if (!t.local && resp.status === 401 && retryAuth) {
    const auth = await storage.get('monarchAuth');
    if (auth && auth.refreshToken) { await refresh(auth); return rpc(method, params, false); }
  }
  const sid = resp.headers.get('Mcp-Session-Id');
  if (sid) sessionId = sid;
  if (!resp.ok) throw new Error('MCP ' + method + ' HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  const ct = resp.headers.get('content-type') || '';
  const data = ct.includes('text/event-stream') ? parseSse(await resp.text()) : await resp.json();
  if (data.error) throw new Error('MCP ' + method + ' error: ' + JSON.stringify(data.error));
  return data.result;
}

async function notify(method, params) {
  const t = await target();
  const token = t.local ? null : await accessToken();
  await fetch(t.url, {
    method: 'POST',
    credentials: 'omit',
    headers: headers(token),
    body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }),
  });
}

async function ensureSession() {
  if (sessionId) return;
  await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'ally-checks-ext', version: '0.1.0' },
  });
  await notify('notifications/initialized');
}

export async function listTools() {
  await ensureSession();
  return await rpc('tools/list', {});
}

export async function callTool(name, args) {
  await ensureSession();
  return await rpc('tools/call', { name, arguments: args || {} });
}
