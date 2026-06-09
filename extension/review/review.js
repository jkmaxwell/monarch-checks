// Review page (full tab): payee strip + editable recipient (autocomplete) per
// check, reading the dataset from the SW and the strips from IndexedDB. Edits
// save back to the SW automatically.
import { getStrip } from '../lib/idb.js';

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let records = [];

async function load() {
  records = (await send({ type: 'dataset/get' })) || [];
  render();
}

function buildDatalist() {
  const counts = {};
  for (const r of records) { const n = (r.recipient || '').trim(); if (n) counts[n] = (counts[n] || 0) + 1; }
  const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  $('recipient-list').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function render() {
  $('count').textContent = String(records.length);
  buildDatalist();
  const tbody = $('rows');
  tbody.innerHTML = '';
  for (const r of records) {
    const tr = document.createElement('tr');
    if (r.confidence !== 'high' || !r.recipient) tr.className = 'needs-review';
    tr.innerHTML =
      `<td class="num">${esc(r.checkNumber)}</td>` +
      `<td class="strip"><img alt="payee strip ${esc(r.checkNumber)}" data-check="${esc(r.checkNumber)}"></td>` +
      `<td class="rec"><input type="text" list="recipient-list" autocomplete="off" value="${esc(r.recipient || '')}" data-check="${esc(r.checkNumber)}"></td>` +
      `<td class="conf"><span class="badge ${esc(r.confidence || 'low')}">${esc(r.confidence || 'low')}</span></td>` +
      `<td class="amt">${esc(r.amount)}</td>` +
      `<td class="date">${esc(r.date)}</td>`;
    tbody.appendChild(tr);
  }
  for (const img of tbody.querySelectorAll('img[data-check]')) {
    getStrip(img.dataset.check).then((blob) => { if (blob) img.src = URL.createObjectURL(blob); });
  }
}

let saveTimer;
$('rows').addEventListener('input', (e) => {
  const input = e.target.closest('input[data-check]');
  if (!input) return;
  const check = input.dataset.check;
  const val = input.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await send({ type: 'dataset/setRecipient', checkNumber: check, recipient: val, confidence: 'high' });
    const rec = records.find((r) => String(r.checkNumber) === String(check));
    if (rec) { rec.recipient = val.trim(); rec.confidence = 'high'; }
    buildDatalist(); // new/corrected names become autocomplete suggestions immediately
    const row = input.closest('tr');
    row.classList.remove('needs-review');
    const badge = row.querySelector('.badge');
    badge.textContent = 'high';
    badge.className = 'badge high';
    $('status').textContent = `Saved #${check}.`;
  }, 400);
});

// Export full-field CSV + JSON, client-side.
function csvEscape(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCsv(rows) {
  const PREFERRED = ['checkNumber', 'date', 'amount', 'recipient', 'confidence', 'type', 'description', 'postedDateTime'];
  const seen = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  const cols = PREFERRED.filter((k) => seen.includes(k)).concat(seen.filter((k) => !PREFERRED.includes(k)));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n') + '\n';
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
$('export').addEventListener('click', () => {
  const clean = records.map(({ extractError, ...r }) => r);
  download('ally-checks-verified.csv', toCsv(clean), 'text/csv');
  download('ally-checks-verified.json', JSON.stringify(clean, null, 2), 'application/json');
  $('status').textContent = `Exported ${clean.length} checks.`;
});

load();
