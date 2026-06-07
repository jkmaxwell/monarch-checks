#!/usr/bin/env node
// Apply a recipients map onto the discovered checks: regenerate a POPULATED
// review.html and write the verified CSV + JSON. This is the manual / non-API
// backend path — the recipients map (checkNumber -> {recipient, confidence})
// can come from a human, from in-session reading, or any source, instead of the
// Claude API call in build-review.js.
//
//   node pipeline/apply-recipients.js [recipients.json]
//
// Default map: pipeline/out/recipients.json
const fs = require('fs');
const path = require('path');

const { discover } = require('./lib/discover');
const { buildReviewHtml } = require('./lib/review-html');
const { toCsv } = require('./lib/csv');

const ROOT = path.join(__dirname, '..');
const DOWNLOADS = path.join(ROOT, 'downloads');
const META = path.join(DOWNLOADS, 'ally-checks-metadata.json');
const STRIPS = path.join(__dirname, 'strips');
const OUT = path.join(__dirname, 'out');

function main() {
  const recipientsPath = process.argv[2] || path.join(OUT, 'recipients.json');
  if (!fs.existsSync(recipientsPath)) {
    console.error(`No recipients map at ${recipientsPath}`);
    process.exit(2);
  }
  const map = JSON.parse(fs.readFileSync(recipientsPath, 'utf8'));
  const records = discover(DOWNLOADS, META);
  fs.mkdirSync(OUT, { recursive: true });

  const out = records.map((r) => {
    const m = map[r.checkNumber] || {};
    const stripPath = path.join(STRIPS, `${r.checkNumber}_payee.png`);
    const stripDataUri = fs.existsSync(stripPath)
      ? 'data:image/png;base64,' + fs.readFileSync(stripPath).toString('base64')
      : '';
    return {
      ...r,
      recipient: String(m.recipient || '').trim(),
      confidence: m.confidence || 'low',
      stripDataUri,
    };
  });

  fs.writeFileSync(path.join(OUT, 'review.html'), buildReviewHtml(out));
  const flat = out.map(({ stripDataUri, ...rest }) => rest);
  fs.writeFileSync(path.join(OUT, 'ally-checks-verified.json'), JSON.stringify(flat, null, 2));
  fs.writeFileSync(path.join(OUT, 'ally-checks-verified.csv'), toCsv(flat));

  const flagged = out.filter((r) => r.confidence !== 'high' || !r.recipient).length;
  console.log(`Applied recipients to ${out.length} checks (${flagged} flagged for review).`);
  console.log('Wrote out/review.html, out/ally-checks-verified.json, out/ally-checks-verified.csv');
}

main();
