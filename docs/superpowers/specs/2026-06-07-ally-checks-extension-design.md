# Ally Checks — Browser Extension (v2) Design

**Date:** 2026-06-07
**Status:** Approved design direction, pre-implementation
**Scope:** A single, self-contained Manifest V3 browser extension that does the
entire flow **client-side, with no Claude Code session at runtime**: capture
checks from Ally → extract recipients via the Claude API → review/correct →
reconcile into Monarch via the official Monarch MCP. Supersedes the Node/CDP
pipeline (v1 + M4), which becomes the reference implementation.

**Predecessors / reference:**
- `docs/superpowers/specs/2026-06-07-ally-checks-downloader-design.md` (v1 capture)
- `docs/superpowers/specs/2026-06-07-ally-checks-m4-data-pipeline-design.md` (extract/review)
- The user's **"Check Merchant + Category Assignment — Procedure Spec"** is the
  authoritative logic for the reconciliation phase (summarized in §6).

## 1. Goals & decisions

- **One extension, all client-side.** Runs in the user's normal logged-in
  browser. No debug browser, no CDP, no Node, no Claude session at runtime.
- **Data-only.** Check image blobs are held in memory only long enough to crop
  the payee strip and extract the recipient. **No full check images are written
  to disk.** The deliverable is data (and live Monarch updates).
- **The user supplies a Claude API key** (stored in extension settings) for the
  in-browser vision extraction.
- **Monarch via the official MCP.** The extension acts as its own MCP client:
  OAuth consent → scoped token → MCP tool calls over HTTP. No private/undocumented
  Monarch API, no Claude session.
- **Target browser:** Dia (Chromium-based) and any Chromium browser, loaded as an
  unpacked MV3 extension.

## 2. Architecture

A Manifest V3 extension with these components:

| Component | Role |
|---|---|
| **Content script (Ally)** — runs in `secure.ally.com` tab | Walks the transaction list, paginates, opens checks, reads blob images + page-text metadata. Ports the proven v1 logic (`findCheckRows`, `openRow`, `expandAndWaitForImages`, metadata read) — now in-page, so no CDP teardown fragility. |
| **Service worker (background)** | Orchestration + all cross-origin fetches: Claude vision API calls, Monarch MCP OAuth + tool calls. Holds no long-lived DOM. |
| **Dashboard page** (extension tab) | The single UI surface: run controls + live progress for capture/extract, the review table, the reconcile step, and a run log. |
| **Options page** | Settings: Claude API key, Monarch connection (OAuth connect/revoke), default history window, editable normalization map. |
| **Storage** | `chrome.storage.local` for settings + dedup history + normalization map + tokens; in-memory (service worker / page) for the working dataset and transient image blobs. |

**Three external endpoints:**

| Endpoint | Purpose | Auth | CORS note |
|---|---|---|---|
| `secure.ally.com` (the tab) | capture | existing Ally session | content script, same-origin to the page |
| `api.anthropic.com` | vision extraction | Claude API key | service-worker fetch + `host_permissions` + `anthropic-dangerous-direct-browser-access: true` |
| `api.monarch.com/mcp` | reconciliation | Monarch OAuth (read+write) | service-worker fetch + `host_permissions` |

**Data flow:** Ally content script → (blobs + metadata) → service worker crops +
calls Claude → recipients → dashboard review table → user corrects → service
worker reconciles via Monarch MCP → run log.

## 3. State & data model

Persisted in `chrome.storage.local`:

- **`settings`**: `{ anthropicApiKey, defaultWindowMonths, ... }`
- **`history`**: the dedup ledger — set of processed `checkNumber`s plus the
  newest check date/number seen, so subsequent runs fetch **only new** checks.
- **`normalizationMap`**: editable `{ variant → canonical }` (seeded with the
  three known typos: `Jayne Doe→Jane Doe`, `Acme Landscaping→Acme
  Co Landscaping`, `Example Flooring and Supply Inc→Example Flooring & Supply Inc`). **No
  payee list is hardcoded** — everything else is discovered live.
- **`monarchAuth`**: OAuth tokens (access + refresh) + expiry + granted scopes.
- **`lastRunLog`**: per-check results from the most recent run.

Per-check working record (in memory, mirrors the M4 schema):
`{ checkNumber, date, amount, recipient, confidence, postedDateTime, description, type, stripDataUri }`
plus reconciliation fields added in P4: `{ transactionId, merchantId, merchantCreated, categoryId, categorySource, status, flagReason }`.

## 4. Capture (in the Ally tab)

Reuses v1's validated approach, adapted to a content script and **data-only**:

1. **First run** asks for a **history window**: 6 months (default), 1 year, 2
   years, or all-time. Subsequent runs ignore the window and fetch only checks
   **not in the dedup history** (newest-first, stopping once it reaches known
   territory).
2. Walk the list (`[data-testid="transaction-history-desc"]` rows, `Check Paid
   #<n>`), reading each row's date from its `<tr>`. Click **View More** until the
   oldest loaded row passes the window/known boundary.
3. For each new check: open it, expand "View check images", poll until both
   `frontCheckImage` / `backCheckImage` blobs are loaded (pick the loaded one
   among duplicates — the v1 fix), and read page-text metadata (check #, amount,
   posted date) from the detail modal.
4. **Instead of downloading**, hand the front blob to the service worker for
   cropping; capture metadata. Close the modal; continue.
5. Resilience: the walker runs in-page (no CDP), so it survives DOM churn; on a
   full navigation the content script re-injects and resumes from the dedup
   history. Per-check try/skip with retry (scroll-into-view + re-click, longer
   waits) — ports the v1/backfill robustness fixes.

## 5. Extract (service worker)

For each captured front blob:

1. **Crop the payee strip** with an `OffscreenCanvas`: draw the image and extract
   the validated region — **780×95 at (80,150)** on the 1176×512 Ally front
   (scale proportionally if dimensions differ). Produces a small PNG; the full
   image is then discarded.
2. **Vision-extract** the recipient: POST to `api.anthropic.com/v1/messages`,
   model `claude-opus-4-8`, the strip as a base64 image block, structured output
   `{ recipient, confidence: high|medium|low }`, header
   `anthropic-dangerous-direct-browser-access: true`. (Ports the M4 prompt +
   schema.) Per-strip try/catch; failures → `{recipient:'', confidence:'low'}`.
3. Keep the strip as a data URI for the review table; drop the full image.

## 6. Review (dashboard page)

The M4 review UI, ported into the extension page:

- Table: payee strip + **editable recipient** (with the `<datalist>` autocomplete
  of distinct names, most-common first) + check #/amount/date + confidence badge;
  low-confidence/empty rows flagged.
- The user corrects names, then clicks **Reconcile** (replaces the old "Export").
  An optional **Export CSV/JSON** remains for an offline copy.
- Corrected recipients feed the dedup history and the reconcile step.

## 7. Reconcile (service worker → Monarch MCP)

Implements the user's **Procedure Spec** verbatim. The input JSON (verified,
post-review) is the **source of truth**; Monarch's own `Ally Bank` / `Check Paid
#NNNN` labels are never used to match or to skip.

**MCP client mechanics (the discovery task):**
- The extension is an MCP client. On first reconcile (or via the Options
  "Connect Monarch" button): discover the OAuth metadata advertised by
  `api.monarch.com/mcp` (`401` + `WWW-Authenticate` / `/.well-known/...`), run
  **OAuth 2.1 PKCE** via `chrome.identity.launchWebAuthFlow` (opens the Monarch
  consent screen; request **read + write**), store tokens, and refresh as needed.
- Speak MCP over Streamable HTTP: `initialize` → `tools/list` (discover the actual
  tool names/schemas) → `tools/call`. The required operations (search
  transactions, get/create/merge merchants, get categories, update transaction)
  map onto Monarch's MCP toolset; the extension **adapts to whatever `tools/list`
  returns** rather than hardcoding tool signatures.

**Per-check logic (from the Procedure Spec — authoritative):**
- **Tiered search:** (1) check number in original statement → (2) date+amount →
  (3) date+amount+recipient disambiguation → (4) flag. Stop at first unambiguous
  single match; sanity-check date+amount; never write on mismatch.
- **Idempotent:** skip if the transaction already has a real payee merchant
  matching the recipient; don't touch a deliberately-set category.
- **Resolve merchant:** normalize via the editable map → search existing
  merchants → use canonical `merchant_id`; **create only** if genuinely absent
  (and the data layer is verified live). Prefer assign over create.
- **Derive category** from the merchant's existing transactions (uniform → use it;
  mixed → dominant + flag; brand-new merchant → leave + flag).
- **Write** merchant (+ category) via update; **verify** the write landed.
- **End-of-run sweep (mandatory):** drive off the JSON — confirm no check is still
  generic, and run duplicate-merchant detection/merge for every payee touched
  (merge low-count dupes into the canonical merchant).
- **Per-check log record:** checkNumber/date/amount/recipient, matched
  transactionId, merchantId (+found/created), categoryId (+how), status
  (written/flagged/skipped), flag reason. Shown in the dashboard run log.

## 8. Settings (options page)

- **Claude API key** (required for extract) — stored in `chrome.storage.local`.
- **Monarch** — Connect (OAuth) / Revoke; shows granted scopes.
- **Default history window** — 6mo / 1y / 2y / all.
- **Normalization map** — editable variant→canonical list.

## 9. Security & privacy

- Check images never touch disk; only the cropped payee strip is sent to
  Anthropic (signature / account / routing excluded by the crop).
- The Claude API key and Monarch tokens live in `chrome.storage.local` on the
  user's machine; document the single-user, local-only assumption.
- Monarch writes are **live and hard to reverse** — the reconcile step shows a
  summary and requires explicit confirmation before writing; idempotency +
  verify-after-write guard against damage.

## 10. Error handling / resilience

- Capture: per-check retry (scroll+re-click, longer waits); skip+log on
  persistent failure; resume from dedup history after navigation.
- Extract: per-strip try/catch → flag low; transient network retry.
- Reconcile: never write on ambiguous match or stale read; verify each write;
  refresh OAuth token on 401; honor the Procedure Spec's "success ≠ landed" rule.

## 11. Unknowns to confirm during implementation

- **Dia unpacked-extension support** — confirm Dia loads an unpacked MV3
  extension (developer mode). If not, fall back to any Chromium browser.
- **Monarch MCP OAuth + transport details** — exact `.well-known` metadata,
  whether dynamic client registration is required, and the Streamable-HTTP
  request shape — reverse-engineered from `api.monarch.com/mcp` (analogous to how
  Ally's DOM was discovered).
- **Monarch MCP tool names/params** — discovered at runtime via `tools/list`.
- **Anthropic browser CORS** — confirm `anthropic-dangerous-direct-browser-access`
  works from an MV3 service worker with `host_permissions`.

## 12. Testing

Build-first (consistent with v1/M4); no formal suite. Verification is manual
against the live Ally + Monarch accounts, reusing validated assets (crop region,
vision prompt). Pure helpers (normalization, tiered-search selection, CSV) get
quick Node sanity checks. Reconcile is exercised first in a **dry-run mode**
(compute all matches/assignments + log, write nothing) before any live write.

## 13. Out of scope

- Fully-local (no-cloud) extraction backend — still a future option.
- Non-Chromium browsers (Safari/Firefox) — the MV3 + MCP-client approach is
  Chromium-first.
- Publishing to the Chrome Web Store — this is a personal, unpacked extension.
