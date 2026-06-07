// Build the work-list from the downloaded front images themselves, so the
// pipeline is robust to a missing or partial metadata.json (e.g. when a long
// download run dies before writing the aggregate JSON). The filename encodes
// the essentials: {date}_check-{number}_{amount}_front.{ext}. metadata.json,
// when present, enriches each record (postedDateTime/description/type).
const fs = require('fs');
const path = require('path');

const FRONT_RE = /_front\.(jpe?g|png)$/i;
const BASE_RE = /^([0-9-]+)_check-(.+)_([0-9.]+|unknown-amount)$/;

function discover(downloadsDir, metaPath) {
  const metaById = {};
  if (metaPath && fs.existsSync(metaPath)) {
    try {
      for (const r of JSON.parse(fs.readFileSync(metaPath, 'utf8'))) metaById[r.checkNumber] = r;
    } catch {
      /* ignore a bad/partial metadata file — filenames are the source of truth */
    }
  }

  const out = [];
  for (const frontFile of fs.readdirSync(downloadsDir).filter((f) => FRONT_RE.test(f))) {
    const ext = frontFile.match(/\.(jpe?g|png)$/i)[0];
    const base = frontFile.replace(FRONT_RE, '');
    const m = base.match(BASE_RE);
    if (!m) continue;
    const [, date, checkNumber, amount] = m;
    const backFile = `${base}_back${ext}`;
    const meta = metaById[checkNumber] || {};
    out.push({
      checkNumber,
      date,
      amount,
      frontFile,
      backFile: fs.existsSync(path.join(downloadsDir, backFile)) ? backFile : meta.backFile || '',
      postedDateTime: meta.postedDateTime || '',
      description: meta.description || `Check Paid #${checkNumber}`,
      type: meta.type || 'Withdrawal',
    });
  }

  out.sort((a, b) => String(a.checkNumber).localeCompare(String(b.checkNumber), undefined, { numeric: true }));
  return out;
}

module.exports = { discover };
