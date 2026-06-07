// Minimal .env loader (no dependency). Loads KEY=VALUE lines from a gitignored
// .env at the project root or pipeline/, without overriding vars already set in
// the environment. Lets the user keep ANTHROPIC_API_KEY in a local file instead
// of exposing it on a command line or in a transcript.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '..', '.env'), // project root
    path.join(__dirname, '..', '.env'), // pipeline/.env
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}

module.exports = { loadEnv };
