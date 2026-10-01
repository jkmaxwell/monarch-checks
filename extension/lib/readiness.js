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
        text: 'Not open. Log in, then open the account’s transactions.',
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
