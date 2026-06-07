#!/usr/bin/env node
// Build the recipient-review page from downloaded check images.
//
//   node pipeline/build-review.js
//
// Reads downloads/ally-checks-metadata.json + the front JPEGs, crops each payee
// strip, extracts the recipient via the Claude API (needs ANTHROPIC_API_KEY),
// and writes pipeline/out/review.html (self-contained) + checks.prelim.json.
//
// Without ANTHROPIC_API_KEY it still builds the page with empty recipients so you
// can read the strips and type the names yourself (manual fallback).
const fs = require('fs');
const path = require('path');

require('./lib/env').loadEnv(); // pick up ANTHROPIC_API_KEY from a gitignored .env
const { cropPayee } = require('./lib/crop');
const { discover } = require('./lib/discover');
const extract = require('./lib/extract');
const { buildReviewHtml } = require('./lib/review-html');
const { toCsv } = require('./lib/csv');

const ROOT = path.join(__dirname, '..');
const DOWNLOADS = path.join(ROOT, 'downloads');
const META = path.join(DOWNLOADS, 'ally-checks-metadata.json');
const STRIPS = path.join(__dirname, 'strips');
const OUT = path.join(__dirname, 'out');

async function main() {
  if (!fs.existsSync(DOWNLOADS)) {
    console.error(`No downloads/ at ${DOWNLOADS}. Run the downloader first.`);
    process.exit(2);
  }
  fs.mkdirSync(STRIPS, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Work-list comes from the front images on disk (robust to missing/partial
  // metadata.json); metadata enriches each record when available.
  const records = discover(DOWNLOADS, META);
  if (records.length === 0) {
    console.error('No check front images found in downloads/.');
    process.exit(2);
  }
  const canExtract = extract.isAvailable();
  if (!canExtract) {
    console.warn(
      'ANTHROPIC_API_KEY not set — skipping automatic extraction. The review ' +
        'page will list every check with an empty recipient for you to fill in.'
    );
  }

  const out = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const label = `#${r.checkNumber} (${i + 1}/${records.length})`;
    if (!r.frontFile) {
      console.warn(`  ${label}: no frontFile, skipping`);
      continue;
    }
    const front = path.join(DOWNLOADS, r.frontFile);
    if (!fs.existsSync(front)) {
      console.warn(`  ${label}: missing ${r.frontFile}, skipping`);
      continue;
    }

    const stripPath = path.join(STRIPS, `${r.checkNumber}_payee.png`);
    try {
      cropPayee(front, stripPath);
    } catch (err) {
      console.error(`  ${label}: crop failed: ${err.message}`);
      continue;
    }

    let recipient = '';
    let confidence = 'low';
    if (canExtract) {
      try {
        const res = await extract.extractRecipient(stripPath);
        recipient = res.recipient;
        confidence = res.confidence;
        console.log(`  ${label}: "${recipient}" [${confidence}]`);
      } catch (err) {
        console.error(`  ${label}: extraction failed: ${err.message}`);
      }
    }

    out.push({
      checkNumber: r.checkNumber,
      date: r.date,
      amount: r.amount,
      recipient,
      confidence,
      postedDateTime: r.postedDateTime || '',
      description: r.description || '',
      type: r.type || '',
      stripDataUri: 'data:image/png;base64,' + fs.readFileSync(stripPath).toString('base64'),
    });
  }

  // Preliminary snapshot (pre-verification) for audit — without the inline images.
  const prelim = out.map(({ stripDataUri, ...rest }) => rest);
  fs.writeFileSync(path.join(OUT, 'checks.prelim.json'), JSON.stringify(prelim, null, 2));
  fs.writeFileSync(path.join(OUT, 'checks.prelim.csv'), toCsv(prelim));

  const html = buildReviewHtml(out);
  const reviewPath = path.join(OUT, 'review.html');
  fs.writeFileSync(reviewPath, html);

  const flagged = out.filter((r) => r.confidence !== 'high' || !r.recipient).length;
  console.log(`\nBuilt review for ${out.length} checks (${flagged} need review).`);
  console.log(`Open: ${reviewPath}`);
  console.log('Correct any names, click "Export verified", then run cleanup.js --confirm.');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
