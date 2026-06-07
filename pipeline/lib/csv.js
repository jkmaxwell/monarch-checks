// CSV helpers. Pure functions — also injected verbatim into the review page so
// the in-browser "Export verified" button builds identical CSV client-side.
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(records) {
  const header = ['date', 'check_number', 'amount', 'recipient', 'confidence'];
  const lines = [header.join(',')];
  for (const r of records) {
    lines.push(
      [r.date, r.checkNumber, r.amount, r.recipient, r.confidence].map(csvEscape).join(',')
    );
  }
  return lines.join('\n') + '\n';
}

module.exports = { csvEscape, toCsv };
