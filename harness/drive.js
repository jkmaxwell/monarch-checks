#!/usr/bin/env node
// CDP harness: connect to an already-running Dia/Chromium (started with
// --remote-debugging-port), find the Ally tab, inject the latest
// src/ally-checks.js, and run a command. Page console is mirrored to stderr;
// the command's JSON result goes to stdout.
//
// Usage:
//   node harness/drive.js inject
//   node harness/drive.js eval "allyChecks.findCheckRows().map(r => r.checkNumber)"
//   node harness/drive.js run '{"MAX_CHECKS":1}'
//
// Downloads triggered by the snippet are routed into ./downloads.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BROWSER_URL = process.env.ALLY_BROWSER_URL || 'http://127.0.0.1:9222';
const SNIPPET_PATH = path.join(__dirname, '..', 'src', 'ally-checks.js');
const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');

async function main() {
  const cmd = process.argv[2] || 'inject';
  const arg = process.argv[3];

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const browser = await puppeteer.connect({
    browserURL: BROWSER_URL,
    defaultViewport: null,
    protocolTimeout: 3_600_000, // 1h — a batch run can take many minutes
  });

  const pages = await browser.pages();
  const page = pages.find((p) => /ally\.com/.test(p.url()));
  if (!page) {
    console.error('No Ally tab found. Open your Ally transactions page in the debug browser.');
    console.error('Open tabs:\n  ' + pages.map((p) => p.url()).join('\n  '));
    await browser.disconnect();
    process.exit(2);
  }
  console.error('Connected to: ' + page.url());

  page.on('console', (msg) => console.error('[page] ' + msg.text()));
  page.on('pageerror', (err) => console.error('[pageerror] ' + err.message));

  // Route the snippet's anchor-download clicks into ./downloads.
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR,
  });

  // Always (re)inject the latest snippet so edits take effect immediately.
  const snippet = fs.readFileSync(SNIPPET_PATH, 'utf8');
  await page.evaluate(snippet);

  let result;
  if (cmd === 'inject') {
    result = { injected: true, url: page.url(), keys: await page.evaluate(() => Object.keys(window.allyChecks || {})) };
  } else if (cmd === 'eval') {
    if (!arg) throw new Error('eval requires an expression argument');
    result = await page.evaluate(`(async () => { return (${arg}); })()`);
  } else if (cmd === 'run') {
    const opts = arg ? JSON.parse(arg) : {};
    result = await page.evaluate(async (o) => await window.allyChecks.run(o), opts);
  } else {
    throw new Error(`unknown command: ${cmd} (use inject | eval | run)`);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await browser.disconnect();
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
