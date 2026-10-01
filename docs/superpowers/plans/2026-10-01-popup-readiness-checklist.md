# Popup Readiness Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Setup" card at the top of the extension popup that shows whether the Claude API key is set, an Ally tab is open, and the Monarch bridge answers, each with a fix link, so a first-time user finds out what is missing before a step fails.

**Architecture:** Row logic (state, copy, fix action) lives in a new pure module `extension/lib/readiness.js`, tested with `node --test`. The popup (`dashboard.js`) gathers raw facts (settings, `chrome.tabs.query`, a new `monarch/ready` service-worker message) and renders the rows the module returns. The service worker gains one message handler that runs the existing MCP `listTools()` under a 4-second timeout and returns `{ ok, mode, tools | error }`.

**Tech Stack:** Vanilla JS ES modules, Manifest V3, Chrome extension APIs (`chrome.tabs`, `chrome.runtime`), Node 22 `node --test` for the pure module.

**Spec:** Approved in chat 2026-10-01 (no spec file; bounded change). Summary of the approved design:
- Setup card above Capture; three rows: Claude API key, Ally tab, Monarch bridge. Dot + label + status text + fix link.
- Checks run on popup open; while any row is red, re-run every 5 s.
- All green: card collapses to one line "Setup complete" with a link to expand.
- Extract button disabled while the API key is missing. Capture and Reconcile unchanged.
- One static hint under the Capture row: "About 1 to 2 minutes per check; Ally throttles. Keeps running when the popup is closed."
- Files: `dashboard.html/.js/.css`, one new `monarch/ready` case in `service-worker.js`. No other files, except the new pure module, its test, and a `homeUrl` field on the bank registry.

## Global Constraints

- No build step, no dependencies: the extension stays vanilla ES modules loaded unpacked.
- Tests live outside `extension/` (in `tests/`) so they are not shipped in the unpacked extension.
- Never put real payee names, account numbers, or the user's employer in source or docs.
- Copy uses plain words. Error copy states the cause and the fix, no exclamation marks.
- Existing popup visual system (`dashboard.css` variables, 4 px rhythm, `.card`, `.pill`, `.hint`, `.row`) is reused, not restyled.
- Commit after each task with a conventional `feat(ext):`/`test(ext):` message and the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

---

### Task 1: Pure readiness module (row models + bridge error copy)

**Files:**
- Create: `extension/lib/readiness.js`
- Create: `tests/readiness.test.mjs`
- Modify: `extension/lib/banks.js` (add `homeUrl`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by Task 3):
  ```js
  // Each row: { state: 'ok' | 'bad' | 'checking', text: string, fix: null | { label: string, action: 'settings' | 'open-bank' } }
  export function keyRow(settings)                 // settings = chrome.storage settings object or null
  export function allyRow(tabCount, bankLabel)     // tabCount = number of matching tabs, or null while checking
  export function bridgeRow(result)                // result = response of 'monarch/ready' or null while checking
  export function bridgeHint(errorMessage)         // string -> short cause+fix copy
  export function allOk(rows)                      // rows = array of row objects -> boolean
  ```
- `banks.js` gains `homeUrl: 'https://secure.ally.com/'` on the `ally` entry.

- [ ] **Step 1: Write the failing tests**

Create `tests/readiness.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyRow, allyRow, bridgeRow, bridgeHint, allOk } from '../extension/lib/readiness.js';

test('keyRow: missing key is bad with a Settings fix', () => {
  const r = keyRow({ anthropicApiKey: '' });
  assert.equal(r.state, 'bad');
  assert.match(r.text, /not set/i);
  assert.deepEqual(r.fix, { label: 'Settings', action: 'settings' });
});

test('keyRow: null settings counts as missing', () => {
  assert.equal(keyRow(null).state, 'bad');
});

test('keyRow: present key is ok with no fix', () => {
  const r = keyRow({ anthropicApiKey: 'sk-ant-x' });
  assert.equal(r.state, 'ok');
  assert.equal(r.fix, null);
});

test('allyRow: null count is checking', () => {
  assert.equal(allyRow(null, 'Ally Bank').state, 'checking');
});

test('allyRow: zero tabs is bad with an Open fix naming the bank', () => {
  const r = allyRow(0, 'Ally Bank');
  assert.equal(r.state, 'bad');
  assert.match(r.text, /transaction page/i);
  assert.deepEqual(r.fix, { label: 'Open Ally Bank', action: 'open-bank' });
});

test('allyRow: one or more tabs is ok', () => {
  assert.equal(allyRow(2, 'Ally Bank').state, 'ok');
  assert.equal(allyRow(2, 'Ally Bank').fix, null);
});

test('bridgeRow: null result is checking', () => {
  assert.equal(bridgeRow(null).state, 'checking');
});

test('bridgeRow: ok result shows tool count', () => {
  const r = bridgeRow({ ok: true, mode: 'local', tools: 61 });
  assert.equal(r.state, 'ok');
  assert.match(r.text, /61 tools/);
  assert.equal(r.fix, null);
});

test('bridgeRow: failure uses bridgeHint and offers Settings', () => {
  const r = bridgeRow({ ok: false, mode: 'local', error: 'Local MCP server unreachable at http://127.0.0.1:8642/mcp — start it (Failed to fetch)' });
  assert.equal(r.state, 'bad');
  assert.match(r.text, /not running/i);
  assert.deepEqual(r.fix, { label: 'Settings', action: 'settings' });
});

test('bridgeRow: official mode not connected says so', () => {
  const r = bridgeRow({ ok: false, mode: 'official', error: 'not connected' });
  assert.equal(r.state, 'bad');
  assert.match(r.text, /not connected/i);
  assert.deepEqual(r.fix, { label: 'Connect', action: 'settings' });
});

test('bridgeHint: maps known failures to cause and fix', () => {
  assert.match(bridgeHint('Local MCP server unreachable at x'), /not running.*install-autostart\.sh/i);
  assert.match(bridgeHint('MCP initialize HTTP 400 Invalid Origin'), /extension.s ID.*README/i);
  assert.match(bridgeHint('MCP tools/list HTTP 401 Unauthorized'), /Monarch session expired.*login_setup\.py/i);
  assert.match(bridgeHint('timed out after 4s'), /timed out/i);
});

test('bridgeHint: unknown error is passed through, trimmed to 90 chars', () => {
  const long = 'x'.repeat(200);
  assert.equal(bridgeHint(long).length, 90);
  assert.equal(bridgeHint(''), 'Unknown error');
});

test('allOk: true only when every row is ok', () => {
  assert.equal(allOk([{ state: 'ok' }, { state: 'ok' }]), true);
  assert.equal(allOk([{ state: 'ok' }, { state: 'checking' }]), false);
  assert.equal(allOk([{ state: 'ok' }, { state: 'bad' }]), false);
  assert.equal(allOk([]), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/readiness.test.mjs`
Expected: every test fails with `Cannot find module '.../extension/lib/readiness.js'`.

- [ ] **Step 3: Write the module**

Create `extension/lib/readiness.js`:

```js
// Popup readiness rows (pure; no chrome.* so it runs under node --test).
// Each row: { state: 'ok'|'bad'|'checking', text, fix: null | { label, action } }
// where action is 'settings' (open the options page) or 'open-bank' (open the
// bank's site). The popup gathers the facts; this module decides the copy.

const SETTINGS = { label: 'Settings', action: 'settings' };

export function keyRow(settings) {
  const has = Boolean(settings && String(settings.anthropicApiKey || '').trim());
  return has
    ? { state: 'ok', text: 'Set', fix: null }
    : { state: 'bad', text: 'Not set. Paste it in Settings.', fix: SETTINGS };
}

export function allyRow(tabCount, bankLabel) {
  if (tabCount == null) return { state: 'checking', text: 'Checking…', fix: null };
  return tabCount > 0
    ? { state: 'ok', text: 'Open', fix: null }
    : {
        state: 'bad',
        text: 'Log in and open your checking account’s transaction page.',
        fix: { label: `Open ${bankLabel}`, action: 'open-bank' },
      };
}

export function bridgeRow(result) {
  if (!result) return { state: 'checking', text: 'Checking…', fix: null };
  if (result.ok) {
    const n = Number(result.tools) || 0;
    return { state: 'ok', text: `Connected, ${n} tools`, fix: null };
  }
  if (result.mode === 'official') {
    return { state: 'bad', text: 'Not connected. Connect Monarch in Settings.', fix: { label: 'Connect', action: 'settings' } };
  }
  return { state: 'bad', text: bridgeHint(result.error), fix: SETTINGS };
}

export function bridgeHint(errorMessage) {
  const m = String(errorMessage || '');
  if (!m) return 'Unknown error';
  if (/unreachable/i.test(m)) return 'Not running. Run scripts/install-autostart.sh in the repo.';
  if (/invalid origin/i.test(m)) return 'Rejected this extension’s ID. See README, Troubleshooting.';
  if (/\b401\b/.test(m)) return 'Monarch session expired. Re-run login_setup.py, then restart the bridge.';
  if (/timed out/i.test(m)) return 'Timed out. The bridge is up but not answering; check its log.';
  return m.length > 90 ? m.slice(0, 90) : m;
}

export function allOk(rows) {
  return rows.length > 0 && rows.every((r) => r && r.state === 'ok');
}
```

- [ ] **Step 4: Add `homeUrl` to the bank registry**

In `extension/lib/banks.js`, change the `ally` entry to:

```js
  ally: {
    label: 'Ally Bank',
    tabMatch: 'https://secure.ally.com/*',
    homeUrl: 'https://secure.ally.com/',
    captureScript: 'content/ally-capture.js',
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/readiness.test.mjs`
Expected: `# pass 13`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/readiness.js extension/lib/banks.js tests/readiness.test.mjs
git commit -m "feat(ext): readiness row models for the popup setup checklist

Pure module (no chrome.*) so node --test covers the copy and state logic;
tests live in tests/ so they are not shipped in the unpacked extension.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `monarch/ready` service-worker message

**Files:**
- Modify: `extension/background/service-worker.js:83-86` (add a case next to `monarch/tools`) and append one function near `probeMonarch`.

**Interfaces:**
- Consumes: `mcp.status()` → `{ mode: 'local', url }` or `{ mode: 'official', connected, scopes }`; `mcp.listTools()` → `{ tools: [...] }` (both already exported from `background/mcp-client.js`).
- Produces (used by Task 3): message `{ type: 'monarch/ready' }` → `{ ok: true, mode, tools: number }` or `{ ok: false, mode, error: string }`. Never rejects; failures are returned as `ok: false`.

There is no test harness for the service worker. Verification is a manual probe from the popup's devtools console in Task 3; this task verifies syntax only.

- [ ] **Step 1: Add the message case**

In `extension/background/service-worker.js`, directly after the `case 'monarch/tools':` pair (line 83–84), add:

```js
    case 'monarch/ready':
      return await monarchReady();
```

- [ ] **Step 2: Add the handler function**

Append to the end of `extension/background/service-worker.js`:

```js
// Popup setup checklist: can we reach Monarch right now? Bounded to 4 s so the
// popup never hangs on a dead socket; errors come back as data, not throws.
async function monarchReady() {
  let st;
  try { st = await mcp.status(); } catch (e) { return { ok: false, mode: 'local', error: String((e && e.message) || e) }; }
  if (st.mode === 'official' && !st.connected) return { ok: false, mode: 'official', error: 'not connected' };
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after 4s')), 4000); });
  try {
    const r = await Promise.race([mcp.listTools(), timeout]);
    return { ok: true, mode: st.mode, tools: ((r && r.tools) || []).length };
  } catch (e) {
    return { ok: false, mode: st.mode, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 3: Syntax-check the worker**

Run: `node --check extension/background/service-worker.js`
Expected: no output, exit 0. (`node --check` parses ES modules with `import` fine; it does not execute them.)

- [ ] **Step 4: Commit**

```bash
git add extension/background/service-worker.js
git commit -m "feat(ext): monarch/ready message — bounded reachability check for the popup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Setup card in the popup

**Files:**
- Modify: `extension/dashboard/dashboard.html` (insert the card after the run banner, add the capture hint)
- Modify: `extension/dashboard/dashboard.css` (append styles)
- Modify: `extension/dashboard/dashboard.js` (import the module, gather facts, render, poll, gate Extract)

**Interfaces:**
- Consumes: `keyRow`, `allyRow`, `bridgeRow`, `allOk` from `../lib/readiness.js` (Task 1); `bank()` from `../lib/banks.js` with its new `homeUrl`; `monarch/ready` message (Task 2); existing `settings/get` message.
- Produces: nothing downstream.

- [ ] **Step 1: Add the markup**

In `extension/dashboard/dashboard.html`, insert this block immediately after the `<p id="runbanner" …>` line and before `<section id="capture" …>`:

```html
  <section id="setup" class="card setup">
    <div class="row spread">
      <div class="card-label">Setup</div>
      <a href="#" id="setup-toggle" hidden>Details</a>
    </div>
    <p id="setup-done" class="hint ok" hidden>Setup complete</p>
    <ul id="setup-rows" class="checks">
      <li data-check="key"><span class="dot"></span><span class="name">Claude API key</span><span class="state"></span><a href="#" class="fix" hidden></a></li>
      <li data-check="ally"><span class="dot"></span><span class="name">Ally tab</span><span class="state"></span><a href="#" class="fix" hidden></a></li>
      <li data-check="bridge"><span class="dot"></span><span class="name">Monarch bridge</span><span class="state"></span><a href="#" class="fix" hidden></a></li>
    </ul>
  </section>
```

Then, inside `<section id="capture">`, insert this line directly after the `<div class="row">…Capture…</div>` block (the one containing `<button id="capture-btn">`) and before `<div class="row util">`:

```html
    <p class="hint">About 1 to 2 minutes per check; Ally throttles. Keeps running when the popup is closed.</p>
```

- [ ] **Step 2: Add the styles**

Append to `extension/dashboard/dashboard.css`:

```css
/* setup checklist */
.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.checks li { display: grid; grid-template-columns: 8px auto 1fr auto; align-items: baseline; column-gap: 8px; font-size: 13px; }
.checks .dot { width: 8px; height: 8px; border-radius: 50%; align-self: center; background: #a8a294; }
.checks li[data-state="ok"] .dot { background: #2e9e5b; }
.checks li[data-state="bad"] .dot { background: var(--accent); }
.checks li[data-state="checking"] .dot { background: #a8a294; animation: breathe 1.8s ease-out infinite; }
.checks .name { font-weight: 700; white-space: nowrap; }
.checks .state { color: var(--muted); font-weight: 600; min-width: 0; }
.checks li[data-state="bad"] .state { color: var(--alert); }
.checks .fix { white-space: nowrap; }
.setup.collapsed .checks { display: none; }
.setup.collapsed #setup-done { display: block; }
.hint.ok { color: #2e9e5b; margin: 0; }
```

- [ ] **Step 3: Wire the popup**

In `extension/dashboard/dashboard.js`, add these imports at the very top (line 1, before the `const $ = …` line):

```js
import { keyRow, allyRow, bridgeRow, allOk } from '../lib/readiness.js';
import { bank } from '../lib/banks.js';
```

Then replace the existing `settings/get` block:

```js
chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => {
  if (s && s.defaultWindowMonths != null) $('window').value = String(s.defaultWindowMonths);
});
```

with:

```js
chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => {
  if (s && s.defaultWindowMonths != null) $('window').value = String(s.defaultWindowMonths);
});
runSetupChecks();
```

Append this block to the end of `extension/dashboard/dashboard.js`:

```js
// --- setup checklist ---
// Facts are gathered here; copy/state decisions live in lib/readiness.js.
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
let setupTimer = null;
let setupExpanded = false; // user clicked Details while all green

function renderRow(key, row) {
  const li = document.querySelector(`#setup-rows li[data-check="${key}"]`);
  li.dataset.state = row.state;
  li.querySelector('.state').textContent = row.text;
  const fix = li.querySelector('.fix');
  if (row.fix) { fix.textContent = row.fix.label; fix.dataset.action = row.fix.action; fix.hidden = false; }
  else { fix.hidden = true; delete fix.dataset.action; }
}

async function runSetupChecks() {
  const settings = await send({ type: 'settings/get' });
  const b = bank(settings && settings.bank);

  const key = keyRow(settings);
  renderRow('key', key);
  $('extract-btn').disabled = key.state !== 'ok' || $('extract-btn').dataset.busy === '1';
  $('extract-btn').title = key.state === 'ok' ? '' : 'Set your Claude API key in Settings first';

  renderRow('ally', allyRow(null, b.label));
  renderRow('bridge', bridgeRow(null));

  const tabs = await new Promise((resolve) => chrome.tabs.query({ url: b.tabMatch }, (t) => resolve(chrome.runtime.lastError ? [] : t)));
  const ally = allyRow(tabs.length, b.label);
  renderRow('ally', ally);

  const ready = await send({ type: 'monarch/ready' });
  const bridge = bridgeRow(ready || { ok: false, mode: 'local', error: 'Service worker not responding' });
  renderRow('bridge', bridge);

  const ok = allOk([key, ally, bridge]);
  const card = $('setup');
  card.classList.toggle('collapsed', ok && !setupExpanded);
  $('setup-toggle').hidden = !ok;
  $('setup-toggle').textContent = setupExpanded ? 'Hide' : 'Details';

  clearTimeout(setupTimer);
  if (!ok) setupTimer = setTimeout(runSetupChecks, 5000);
}

$('setup-toggle').addEventListener('click', (e) => {
  e.preventDefault();
  setupExpanded = !setupExpanded;
  $('setup').classList.toggle('collapsed', !setupExpanded);
  $('setup-toggle').textContent = setupExpanded ? 'Hide' : 'Details';
});

$('setup-rows').addEventListener('click', (e) => {
  const a = e.target.closest('a.fix');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.action === 'open-bank') {
    chrome.runtime.sendMessage({ type: 'settings/get' }, (s) => chrome.tabs.create({ url: bank(s && s.bank).homeUrl }));
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  }
});
```

Finally, make the run-state gating and the key gating cooperate. Replace the existing `setBusy`:

```js
function setBusy(b) { $('capture-btn').disabled = b; $('extract-btn').disabled = b; }
```

with:

```js
function setBusy(b) {
  $('capture-btn').disabled = b;
  $('extract-btn').dataset.busy = b ? '1' : '0';
  // Extract also needs an API key; the setup check owns that part of the flag.
  $('extract-btn').disabled = b || document.querySelector('#setup-rows li[data-check="key"]').dataset.state !== 'ok';
}
```

- [ ] **Step 4: Syntax-check and run the unit tests**

Run:
```bash
node --check extension/dashboard/dashboard.js && node --test tests/readiness.test.mjs
```
Expected: no syntax errors; `# pass 13`.

- [ ] **Step 5: Static DOM check**

Confirm every id the script references exists in the markup:

```bash
for id in setup setup-toggle setup-done setup-rows extract-btn capture-btn; do grep -q "id=\"$id\"" extension/dashboard/dashboard.html && echo "ok $id" || echo "MISSING $id"; done
```
Expected: six `ok` lines.

- [ ] **Step 6: Manual verification in the browser (user-assisted)**

The extension runs unpacked in the user's browser, which this session cannot drive. Ask the user to:
1. `dia://extensions` → Reload the extension.
2. Open the popup with the bridge running and an Ally tab open. Expected: card collapsed to "Setup complete" with a Details link; Extract enabled.
3. Close the Ally tab, reopen the popup. Expected: Ally row red with "Open Ally Bank" link; within 5 s of reopening an Ally tab it turns green without reopening the popup.
4. Stop the bridge (`launchctl bootout gui/$(id -u)/com.monarch-checks.mcp-http`), reopen the popup. Expected: Monarch bridge row red, "Not running. Run scripts/install-autostart.sh in the repo." Restart with `./scripts/install-autostart.sh`; row goes green within about 10 s.
5. Settings → clear the API key → Save, reopen the popup. Expected: key row red, Extract disabled with a tooltip. Re-paste the key.
6. Open the popup's devtools console (right-click the popup → Inspect) and confirm no errors.

Record each result in the commit body or the chat before committing.

- [ ] **Step 7: Commit**

```bash
git add extension/dashboard/dashboard.html extension/dashboard/dashboard.css extension/dashboard/dashboard.js
git commit -m "feat(ext): setup checklist in the popup — API key, Ally tab, Monarch bridge

Runs on open, re-polls every 5 s while anything is red, collapses to one
line when all green. Extract is disabled until an API key is set. Adds the
capture-speed hint so the first run's pace isn't a surprise.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: README note

**Files:**
- Modify: `README.md` Usage section (the numbered list starting "1. Log into Ally…") and the Troubleshooting table.

**Interfaces:** none.

- [ ] **Step 1: Mention the checklist in Usage**

In `README.md`, replace the Usage list's first item:

```
1. Log into Ally and open the account's transaction page (the one with
   `Check Paid #…` rows). Leave the tab open.
```

with:

```
1. Log into Ally and open the account's transaction page (the one with
   `Check Paid #…` rows). Leave the tab open. The popup's Setup card shows
   three rows: Claude API key, Ally tab, Monarch bridge. All three green
   before you start; each red row has a fix link.
```

- [ ] **Step 2: Point the first troubleshooting row at the card**

Replace:

```
| "Local MCP server unreachable" | The bridge isn't running — step 4 above |
```

with:

```
| Setup card: Monarch bridge "Not running" | The bridge isn't running — step 4 above |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: point first-run users at the popup setup card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
