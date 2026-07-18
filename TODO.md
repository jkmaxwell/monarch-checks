# TODO

## Future: multi-bank capture support

The Settings → Bank selector and `extension/lib/banks.js` registry exist; only
Ally is implemented. Adding a bank means:

1. **A bank-specific capture content script** (the real work) — port the
   walk/paginate/open-modal/wait-for-images/crop logic in
   `extension/content/ally-capture.js` to the new bank's DOM.
2. A `BANKS` entry in `extension/lib/banks.js` (`label`, `tabMatch`,
   `captureScript`).
3. `host_permissions` + `content_scripts` entries in `extension/manifest.json`.

**Requirement before any second bank ships:** the dedup history
(`history.processed`) and dataset records are keyed by bare check number —
check #1795 at Ally and #1795 at another bank would collide. Namespace both by
bank id (with a one-time migration of existing records) first. Also audit
bank-specific strings baked into the capture engine (Ally's throttle and
"can't load your check images" detection copy).

## Smaller items

- Duplicate-merchant merge sweep only runs in official-MCP mode; revisit if
  Monarch's official MCP regains Plaid visibility (then official mode becomes
  usable again — see extension/README.md).
- Optional `wide_search` fallback for the local MCP's tier-1 check-number
  lookup (one-line change in `extension/background/monarch.js`) if server-side
  search ever misses.
- Extension icons (`manifest.json` has none — toolbar shows the default
  puzzle piece).
