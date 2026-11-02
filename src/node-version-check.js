'use strict';
// Runs on every entry point before any other module loads, so it must stay
// parseable by the oldest Node.js version this project supports. It enforces
// the "engines.node" range from package.json and exits non-zero when the
// running Node.js is too old (for example v20, which breaks the Pi harness).
const fs = require('node:fs');
const path = require('node:path');

function parseVersion(value) {
  const parts = String(value).replace(/^v/, '').split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function nodeVersionSatisfies(version, range) {
  const match = /^>=\s*(\d+(?:\.\d+){0,2})/.exec(String(range).trim());
  if (!match) throw new Error(`Unsupported engines.node range: ${range}`);
  const required = parseVersion(match[1]);
  const actual = parseVersion(version);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

function requiredNodeRange() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return manifest.engines && manifest.engines.node;
}

function assertNodeVersion() {
  const range = requiredNodeRange();
  if (range && !nodeVersionSatisfies(process.versions.node, range)) {
    console.error(`ok-workbench requires Node.js ${range} but found v${process.versions.node}. Upgrade Node.js (for example to v24) and start ok-workbench again.`);
    process.exit(1);
  }
}

assertNodeVersion();

module.exports = { assertNodeVersion, nodeVersionSatisfies, parseVersion, requiredNodeRange };
