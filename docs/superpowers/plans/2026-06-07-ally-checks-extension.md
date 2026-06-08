# Ally Checks Browser Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single Manifest V3 browser extension that captures checks from Ally, extracts recipients via the Claude API, lets the user review/correct, and reconciles them into Monarch via the official Monarch MCP — entirely client-side, no Claude session.

**Architecture:** Content script (Ally DOM) → service worker (all cross-origin fetches: Anthropic + Monarch MCP; CORS bypass via `host_permissions`) → dashboard/options pages (UI). Data-only: image blobs cropped in-memory, full images never persisted. Reconciliation follows the user's procedure spec.

**Tech Stack:** Manifest V3, vanilla JS (ES modules), `chrome.{runtime,storage,identity,alarms}`, `OffscreenCanvas`, IndexedDB, Anthropic Messages API (direct browser access), Monarch MCP (OAuth 2.1 PKCE + Streamable HTTP).

**Reference spec:** `docs/superpowers/specs/2026-06-07-ally-checks-extension-design.md` (and the user's "Check Merchant + Category Assignment" procedure spec for Phase 4).

**Verification:** Build-first, no formal test suite. Pure helpers get quick `node --check`/Node sanity checks. Everything live (Ally/Anthropic/Monarch) is verified by loading the unpacked extension in Chrome (then Dia) and running it against the real accounts. Each phase ends loadable and testable.

**Reuse:** Port proven logic from the existing repo — `src/ally-checks.js` (capture selectors + waits), `pipeline/lib/crop.js` (crop region 780×95+80+150), `pipeline/lib/extract.js` (vision prompt + schema), `pipeline/lib/review-html.js` (review table + datalist autocomplete), `pipeline/lib/csv.js`, `pipeline/lib/discover.js` (filename parse not needed; metadata comes live).

---

## File structure (all under `extension/`)

- `manifest.json` — MV3 manifest (permissions, host_permissions, content script, SW, pages).
- `background/service-worker.js` — entry; message router; keep-alive (`chrome.alarms`).
- `background/anthropic.js` — `extractRecipient(stripBlob)` via Anthropic Messages API.
- `background/crop.js` — `cropPayee(imageBlob)` via `OffscreenCanvas`.
- `background/mcp-client.js` — Monarch MCP client: OAuth (DCR + PKCE) + Streamable-HTTP `callTool()`.
- `background/monarch.js` — high-level Monarch ops built on `mcp-client` (search tx, get/create/merge merchant, get categories, update tx).
- `background/reconcile.js` — the procedure-spec engine (tiered search, idempotent assign, normalize, category-derive, dup-merge, verify, dry-run).
- `content/ally-capture.js` — content script: walk/paginate Ally, open checks, read blobs + metadata, post to SW.
- `lib/storage.js` — `chrome.storage.local` helpers (settings, history, normalizationMap, monarchAuth, runLog).
- `lib/idb.js` — IndexedDB helpers for strip blobs.
- `lib/normalize.js` — `normalize(name, map)` (pure).
- `lib/util.js` — pure helpers (date parse, amount parse, pkce, base64).
- `dashboard/dashboard.html` + `dashboard/dashboard.js` + `dashboard/dashboard.css` — run controls, progress, review table, reconcile + run log.
- `options/options.html` + `options/options.js` — settings (Claude key, Monarch connect/revoke, default window, normalization map editor).

---

## Phase 1 — Scaffold + Capture (loadable extension that captures checks)

### Task 1.1: Manifest + skeleton

**Files:** Create `extension/manifest.json`, `extension/background/service-worker.js`, `extension/dashboard/dashboard.html`, `extension/dashboard/dashboard.js`, `extension/options/options.html`, `extension/options/options.js`.

- [ ] **Step 1: Write the manifest**

```json
{
  "manifest_version": 3,
  "name": "Ally Checks",
  "version": "0.1.0",
  "description": "Capture Ally checks, extract recipients, reconcile into Monarch.",
  "permissions": ["identity", "storage", "alarms", "unlimitedStorage", "scripting"],
  "host_permissions": [
    "https://secure.ally.com/*",
    "https://api.anthropic.com/*",
    "https://api.monarch.com/*"
  ],
  "background": { "service_worker": "background/service-worker.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://secure.ally.com/*"], "js": ["content/ally-capture.js"], "run_at": "document_idle" }
  ],
  "action": { "default_title": "Ally Checks", "default_popup": "dashboard/dashboard.html" },
  "options_page": "options/options.html",
  "icons": {}
}
```

- [ ] **Step 2: Minimal SW + pages** — `service-worker.js` logs on install and routes messages; `dashboard.html`/`options.html` minimal shells with their JS. (Create `content/ally-capture.js` as an empty file so the manifest loads.)

```javascript
// background/service-worker.js
chrome.runtime.onInstalled.addListener(() => console.log('Ally Checks installed'));
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // router filled in later tasks
  if (msg?.type === 'ping') { sendResponse({ ok: true }); return; }
  return false;
});
```

- [ ] **Step 3: Load + verify** — In Chrome `chrome://extensions` → Developer mode → Load unpacked → `extension/`. Expected: loads with no manifest errors; SW console shows "installed"; clicking the toolbar icon opens the dashboard shell.

- [ ] **Step 4: Commit** — `git add extension && git commit -m "feat(ext): MV3 scaffold (manifest, SW, dashboard, options)"`

### Task 1.2: Storage + IndexedDB helpers

**Files:** Create `extension/lib/storage.js`, `extension/lib/idb.js`, `extension/lib/util.js`.

- [ ] **Step 1: Pure util helpers** — `parseAmount`, `parseDate` (port from `pipeline/lib/csv.js`/`src/ally-checks.js`), `pkceChallenge()` (S256 via `crypto.subtle`), `b64FromBlob`. Provide complete implementations.
- [ ] **Step 2: storage.js** — typed getters/setters over `chrome.storage.local` for `settings`, `history` (`{processed: string[], newestCheckNumber}`), `normalizationMap`, `monarchAuth`, `runLog`. Complete code.
- [ ] **Step 3: idb.js** — open DB `allychecks`, store `strips` (key=checkNumber, value=Blob); `putStrip`, `getStrip`, `clearStrips`. Complete code.
- [ ] **Step 4: Node sanity** — `node -e` check `parseAmount("−$250.00")==="250.00"`, `parseDate("Jun 2, 2026 ...")==="2026-06-02"`. Expected PASS.
- [ ] **Step 5: Commit** — `feat(ext): storage, idb, util helpers`

### Task 1.3: Ally capture content script

**Files:** Create `extension/content/ally-capture.js`. Port from `src/ally-checks.js`.

- [ ] **Step 1: In-page capture engine** — port `findCheckRows` (with `<tr>` date), `clickViewMore`/pagination to a window/known boundary, `openRow`, `expandAndWaitForImages` (pick loaded blob among duplicates), `readModalMetadata`, `closeModal`, plus per-check robustness (scrollIntoView + re-click). Add: for each new check, `fetch(blobUrl)→blob` for front, and post `{type:'capture/check', record, frontB64}` to the SW (blob → base64 for messaging, since structured-clone of Blob across messaging is unreliable). Dedup against `history.processed`. Drive via messages: SW sends `{type:'capture/start', windowMonths|sinceKnown}`; content script streams progress `{type:'capture/progress'}` and a final `{type:'capture/done', count}`.
- [ ] **Step 2: SW routes capture** — service-worker stores each captured record (metadata) in memory + dedup history; holds frontB64 for Phase 2. (Until Phase 2, just count.)
- [ ] **Step 3: Live verify** — load extension, log into Ally transactions page, open dashboard, click "Capture" (window: 6mo). Expected: progress logs; ends with N new checks captured; re-running captures 0 (dedup). Verify metadata (check#, amount, date) correct in SW console.
- [ ] **Step 4: Commit** — `feat(ext): Ally capture content script (data-only, dedup, window)`

### Task 1.4: Dashboard run UI + first-run window

**Files:** Modify `extension/dashboard/dashboard.{html,js}`.

- [ ] **Step 1: UI** — a "Capture" button; first-run window selector (6mo default / 1y / 2y / all); a live progress area; a captured-count + table-of-metadata preview. Wire to SW via `chrome.runtime.sendMessage`/`onMessage`. Complete code.
- [ ] **Step 2: Live verify** — full capture run from the dashboard; progress updates visibly; preview lists captured checks.
- [ ] **Step 3: Commit** — `feat(ext): dashboard capture UI + history window`

**End of Phase 1: extension loads, captures new Ally checks (data-only, dedup, window), shows them.**

---

## Phase 2 — Extract (recipients via Claude vision, in-browser)

### Task 2.1: Crop in the service worker

**Files:** Create `extension/background/crop.js`.

- [ ] **Step 1:** `async function cropPayee(imageBlob)` → `createImageBitmap(imageBlob)` → if width≈1176 use region `(80,150,780,95)`, else scale proportionally → draw to `OffscreenCanvas` → `convertToBlob({type:'image/png'})`. Store via `idb.putStrip(checkNumber, blob)`. Complete code.
- [ ] **Step 2: Live verify** — after a capture, confirm strips are produced (log dims) and stored in IDB; spot-check one strip renders a payee line.
- [ ] **Step 3: Commit** — `feat(ext): OffscreenCanvas payee-strip crop`

### Task 2.2: Anthropic vision extraction

**Files:** Create `extension/background/anthropic.js`.

- [ ] **Step 1:** `async function extractRecipient(stripBlob, apiKey)` → base64 → POST `https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`; body model `claude-opus-4-8`, image block + the M4 prompt, `output_config.format` json_schema `{recipient, confidence}`, `thinking:{type:'adaptive'}`, `output_config.effort:'high'`. Parse first text block JSON. Port prompt/schema from `pipeline/lib/extract.js`. Per-strip try/catch → `{recipient:'',confidence:'low'}`. Complete code.
- [ ] **Step 2: Options — API key field** — add Claude API key input to options; store in `settings`. Complete code.
- [ ] **Step 3: Wire** — SW: after capture, for each check, `cropPayee` → `extractRecipient` → attach `{recipient,confidence}` to the record; stream progress.
- [ ] **Step 4: Live verify** — set key in options; run; confirm recipients populate (matching the known names) with confidence. (One real API call first to confirm auth.)
- [ ] **Step 5: Commit** — `feat(ext): in-browser Claude vision recipient extraction`

**End of Phase 2: extension captures + extracts recipients end-to-end in the browser.**

---

## Phase 3 — Review (port the M4 review table into the dashboard)

### Task 3.1: Review table

**Files:** Modify `extension/dashboard/dashboard.{html,js,css}`. Port `pipeline/lib/review-html.js`.

- [ ] **Step 1:** Render the review table: strip (object URL from IDB) + editable recipient input with `<datalist>` autocomplete (distinct names, most-common first) + check#/amount/date + confidence badge; flag low/empty rows. Persist edits to the in-SW dataset + dedup history on change. Port the markup/CSS + the soft datalist-arrow style. Complete code.
- [ ] **Step 2:** Optional "Export CSV/JSON" (port `toCsv`, full-field). Complete code.
- [ ] **Step 3: Live verify** — after capture+extract, the table shows strips + names; editing persists; autocomplete works; export downloads full-field files.
- [ ] **Step 4: Commit** — `feat(ext): in-dashboard review table with autocomplete`

**End of Phase 3: capture → extract → review, all in the extension. (Equivalent to the old pipeline, no debug browser.)**

---

## Phase 4 — Reconcile (Monarch MCP client + procedure-spec engine)

### Task 4.1: Monarch MCP client (OAuth + transport)

**Files:** Create `extension/background/mcp-client.js`. (See spec §7 — research-validated flow.)

- [ ] **Step 1: OAuth** — discover `/.well-known/oauth-protected-resource/mcp` + `/.well-known/oauth-authorization-server`; DCR once (`/oauth/register`, redirect = `chrome.identity.getRedirectURL()`, `token_endpoint_auth_method:'none'`) → persist `client_id`; PKCE S256 via `lib/util.pkceChallenge`; `chrome.identity.launchWebAuthFlow` to `/oauth/authorize/` (scope `mcp:read mcp:write`, `resource=https://api.monarch.com/mcp`); exchange at `/oauth/token/`; store + refresh tokens in `monarchAuth`. Complete code.
- [ ] **Step 2: Transport** — `initialize` (capture `Mcp-Session-Id`, send `MCP-Protocol-Version: 2025-06-18`, `Accept: application/json, text/event-stream`), `notifications/initialized`, `listTools()`, `callTool(name, args)` (handle JSON or SSE response, echo session id + bearer, refresh on 401). Keep SW alive with `chrome.alarms` during a run. Complete code.
- [ ] **Step 3: Options — Connect Monarch** — button → runs OAuth; shows granted scopes; Revoke. Complete code.
- [ ] **Step 4: Live verify** — click Connect → Monarch consent screen → approve; `listTools()` logs the real tool names/schemas. **Record the actual tool names/params** for Task 4.2.
- [ ] **Step 5: Commit** — `feat(ext): Monarch MCP client (OAuth PKCE + streamable HTTP)`

### Task 4.2: Monarch high-level ops

**Files:** Create `extension/background/monarch.js`. (Tool names from Task 4.1 Step 4.)

- [ ] **Step 1:** Wrap `callTool` into: `searchTransactions({query|checkNumber|date+amount})`, `getMerchants(name)`, `createMerchant(name)`, `mergeMerchants(fromId,toId)`, `getCategories()`, `getMerchantTransactions(merchantId)`, `updateTransaction(txId,{merchantId,categoryId})`. Map to the discovered tool names/params. Complete code.
- [ ] **Step 2: Live verify** — read-only: search a known check number, fetch a known merchant; confirm responses match the live UI.
- [ ] **Step 3: Commit** — `feat(ext): Monarch high-level operations`

### Task 4.3: Reconcile engine (procedure spec)

**Files:** Create `extension/background/reconcile.js`, `extension/lib/normalize.js`.

- [ ] **Step 1: normalize.js** — `normalize(name, map)` pure; default map = the 3 known typos; editable in options. Node sanity check. Complete code.
- [ ] **Step 2: Engine** — per the procedure spec: tiered search (check# → date+amount → disambiguate → flag), idempotent skip, merchant resolve (normalize → search → create-only-if-absent), category derive (uniform/dominant/none+flag), update, verify-after-write, per-check log record. **Dry-run mode** (compute everything, write nothing). End-of-run sweep: completeness check driven off the JSON + duplicate-merchant detection/merge. Complete code.
- [ ] **Step 3: Options — normalization map editor.** Complete code.
- [ ] **Step 4: Dashboard — Reconcile UI** — "Dry run" + "Reconcile" buttons; confirmation summary before any write; live run log (written/flagged/skipped + reasons). Complete code.
- [ ] **Step 5: Live verify** — **dry-run first** on the reviewed set; inspect the planned matches/assignments + flags; then a real reconcile on a small subset; confirm writes land in the Monarch UI; re-run → all skipped (idempotent); confirm no duplicate merchants. 
- [ ] **Step 6: Commit** — `feat(ext): Monarch reconciliation engine (procedure spec) + dry-run`

**End of Phase 4: full pipeline in one extension — capture → extract → review → reconcile into Monarch.**

---

## Self-Review Notes

- **Spec coverage:** capture/window/dedup (P1), data-only crop + in-browser vision (P2), review+autocomplete (P3), MCP-client OAuth + procedure-spec reconcile + dry-run + dup-merge (P4), settings/options (2.2/4.1/4.3), CORS-in-SW discipline (manifest + all fetches in SW), storage/IDB (1.2). Security: API key/tokens in storage, crop-only-to-Anthropic, confirm-before-write (P4.3). Out-of-scope items remain out.
- **Build-first:** no TDD red-green (per user); pure helpers get Node sanity checks; live flows verified by loading the unpacked extension. This deviates from the skill's TDD default by explicit user preference.
- **Residuals folded into tasks:** real Monarch tool names discovered in 4.1.4 and consumed in 4.2; Dia confirmation after Chrome build.
- **Type consistency:** the per-check record shape (spec §3) flows through capture→extract→review→reconcile; `callTool`/`searchTransactions`/`updateTransaction` names are consistent across 4.1–4.3.
