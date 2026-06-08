// CSV helpers. Pure functions — also injected verbatim into the review page so
// the in-browser "Export verified" button builds identical CSV client-side.
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Emit every field present on the records (CSV mirrors the JSON), with a
// preferred column order up front and any extra keys appended. Self-contained
// (only depends on csvEscape) so it works verbatim when injected into the page.
function toCsv(records) {
  if (!records || !records.length) return '';
  const PREFERRED = [
    'checkNumber', 'date', 'amount', 'recipient', 'confidence',
    'type', 'description', 'postedDateTime', 'frontFile', 'backFile',
  ];
  const seen = [];
  for (const r of records) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  const cols = PREFERRED.filter((k) => seen.includes(k)).concat(
    seen.filter((k) => !PREFERRED.includes(k))
  );
  const lines = [cols.join(',')];
  for (const r of records) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  return lines.join('\n') + '\n';
}

module.exports = { csvEscape, toCsv };
