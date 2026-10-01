// Bank registry (ES module). Each bank supplies the tab-match pattern used to
// find its logged-in tab and the capture content script that knows its DOM.
// Only Ally exists today — the capture engine is bank-specific, so adding a
// bank means a new entry here, a new content script, and a host_permissions +
// content_scripts entry in the manifest.
export const BANKS = {
  ally: {
    label: 'Ally Bank',
    tabMatch: 'https://secure.ally.com/*',
    homeUrl: 'https://secure.ally.com/',
    captureScript: 'content/ally-capture.js',
  },
};

export function bank(id) {
  return BANKS[id] || BANKS.ally;
}
