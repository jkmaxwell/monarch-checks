#!/usr/bin/env node
// Delete the raw check images and cropped strips once you've verified and saved
// the dataset. The verified data is what you keep; the images are intermediate.
//
//   node pipeline/cleanup.js            # dry run — lists what would be deleted
//   node pipeline/cleanup.js --confirm  # actually delete
//
// Preserves pipeline/out/ (review.html, prelim data) and the metadata JSON.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOWNLOADS = path.join(ROOT, 'downloads');
const STRIPS = path.join(__dirname, 'strips');

function listImages(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
    .map((f) => path.join(dir, f));
}

function main() {
  const confirm = process.argv.includes('--confirm');
  const targets = [
    ...listImages(DOWNLOADS, ['.jpg', '.jpeg', '.png']),
    ...listImages(STRIPS, ['.png']),
  ];

  if (targets.length === 0) {
    console.log('Nothing to clean up — no check images or strips found.');
    return;
  }

  console.log(`${targets.length} file(s) ${confirm ? 'being deleted' : 'would be deleted'}:`);
  for (const f of targets) console.log('  ' + path.relative(ROOT, f));

  if (!confirm) {
    console.log('\nDry run. Re-run with --confirm to delete. (Verified data in pipeline/out/ is kept.)');
    return;
  }

  let n = 0;
  for (const f of targets) {
    try {
      fs.unlinkSync(f);
      n++;
    } catch (err) {
      console.error(`  failed to delete ${f}: ${err.message}`);
    }
  }
  console.log(`\nDeleted ${n} file(s). Dataset in pipeline/out/ preserved.`);
}

main();
