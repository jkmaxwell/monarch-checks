// Build a self-contained review page: payee strip + editable recipient per check,
// low-confidence rows flagged, and an "Export verified" button that builds
// CSV + JSON client-side (no server) from the current input values.
const { csvEscape, toCsv } = require('./csv');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// records: [{ checkNumber, date, amount, recipient, confidence, stripDataUri, postedDateTime, description, type }]
function buildReviewHtml(records) {
  // META carries everything EXCEPT the recipient (read live from inputs) and the
  // strip image (display-only). Export merges META + edited recipients.
  const meta = records.map((r) => ({
    checkNumber: r.checkNumber,
    date: r.date,
    amount: r.amount,
    confidence: r.confidence,
    type: r.type || '',
    description: r.description || '',
    postedDateTime: r.postedDateTime || '',
    frontFile: r.frontFile || '',
    backFile: r.backFile || '',
  }));

  // Autocomplete suggestions: distinct names already in the set, most-common
  // first, so typing "jane" surfaces "Jane Doe" and variants converge.
  const counts = {};
  for (const r of records) {
    const n = (r.recipient || '').trim();
    if (n) counts[n] = (counts[n] || 0) + 1;
  }
  const suggestions = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const datalist = `<datalist id="recipient-list">${suggestions
    .map((n) => `<option value="${esc(n)}"></option>`)
    .join('')}</datalist>`;

  const rows = records
    .map((r, i) => {
      const needs = r.confidence !== 'high' || !r.recipient ? ' needs-review' : '';
      return `
      <tr class="row${needs}" data-i="${i}">
        <td class="num">${esc(r.checkNumber)}</td>
        <td class="strip"><img src="${r.stripDataUri || ''}" alt="payee strip for check ${esc(
        r.checkNumber
      )}"></td>
        <td class="rec"><input id="rec-${i}" type="text" list="recipient-list" autocomplete="off" value="${esc(r.recipient)}"></td>
        <td class="conf"><span class="badge ${esc(r.confidence)}">${esc(r.confidence)}</span></td>
        <td class="amt">${esc(r.amount)}</td>
        <td class="date">${esc(r.date)}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ally Checks — Verify Recipients (${records.length})</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 0 0 96px; }
  header { position: sticky; top: 0; background: Canvas; border-bottom: 1px solid #8884; padding: 14px 20px; display: flex; align-items: center; gap: 16px; z-index: 2; }
  header h1 { font-size: 17px; margin: 0; }
  header .spacer { flex: 1; }
  button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 8px; border: 1px solid #8886; background: #2563eb; color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: inherit; }
  .hint { color: #8a8a8a; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #8882; text-align: left; vertical-align: middle; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #8a8a8a; position: sticky; top: 53px; background: Canvas; }
  td.strip img { display: block; max-width: 460px; height: auto; background: #fff; border: 1px solid #8883; border-radius: 4px; }
  td.rec input { font: inherit; width: 240px; padding: 7px 9px; border-radius: 6px; border: 1px solid #8886; background: Field; color: FieldText; }
  /* datalist dropdown arrow (the little triangle) — centered, ~40% gray */
  td.rec input::-webkit-calendar-picker-indicator { opacity: 0.4; margin: auto 0; align-self: center; }
  td.num, td.amt, td.date { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .badge { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .badge.high { background: #16a34a22; color: #16a34a; }
  .badge.medium { background: #d9770622; color: #d97706; }
  .badge.low { background: #dc262622; color: #dc2626; }
  tr.needs-review { background: #d977060e; }
  tr.needs-review td.rec input { border-color: #d97706; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; background: Canvas; border-top: 1px solid #8884; padding: 12px 20px; display: flex; gap: 12px; align-items: center; }
</style>
</head>
<body>
<header>
  <h1>Verify check recipients</h1>
  <span class="hint">${records.length} checks · highlighted rows need review · edit any name, then export</span>
  <span class="spacer"></span>
  <button id="export">Export verified (CSV + JSON)</button>
</header>
<table>
  <thead>
    <tr><th>Check #</th><th>Payee strip</th><th>Recipient</th><th>Confidence</th><th>Amount</th><th>Date</th></tr>
  </thead>
  <tbody>${rows}
  </tbody>
</table>
${datalist}
<footer>
  <span class="hint" id="status">Review the highlighted rows, correct any names, then click Export.</span>
</footer>
<script>
  const META = ${JSON.stringify(meta)};
  ${csvEscape.toString()}
  ${toCsv.toString()}
  function collect() {
    return META.map((m, i) => ({
      ...m,
      recipient: (document.getElementById('rec-' + i).value || '').trim(),
    }));
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  document.getElementById('export').addEventListener('click', () => {
    const records = collect();
    download('ally-checks-verified.csv', toCsv(records), 'text/csv');
    download('ally-checks-verified.json', JSON.stringify(records, null, 2), 'application/json');
    const blank = records.filter((r) => !r.recipient).length;
    document.getElementById('status').textContent =
      'Exported ' + records.length + ' checks' + (blank ? ' (' + blank + ' still have no recipient)' : '') + '. Files are in your Downloads folder.';
  });
</script>
</body>
</html>
`;
}

module.exports = { buildReviewHtml };
