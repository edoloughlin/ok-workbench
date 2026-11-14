'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { createRequire } = require('node:module');
const hash = source => crypto.createHash('sha256').update(source).digest('hex');
const versions = { '@earendil-works/pi-ai': '1.5.0', '@google/genai': '2.21.0' };

function unsupported(message) {
  return Object.assign(new Error(`Pi inference patch: ${message}`), { code: 'PI_INFERENCE_PATCH_UNSUPPORTED' });
}

async function packageRoot(name) {
  const { resolveRuntimePackage } = await import('./pi-runtime-resolve.mjs');
  // Resolve the SDK from Pi's package, including non-hoisted npm layouts.
  const entry = name === '@google/genai'
    ? createRequire(path.join(await packageRoot('@earendil-works/pi-ai'), 'package.json')).resolve(name)
    : fileURLToPath(resolveRuntimePackage(name));
  let directory = path.dirname(entry);
  for (;;) {
    const manifest = await fs.readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (manifest?.name === name) {
      if (manifest.version !== versions[name]) throw unsupported(`unsupported ${name} version`);
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw unsupported(`cannot locate ${name}`);
    directory = parent;
  }
}

function transform(source, entry) {
  let result = source;
  for (const replacement of entry.replacements) {
    const at = result.indexOf(replacement.before);
    if (!replacement.before || at < 0 || result.indexOf(replacement.before, at + replacement.before.length) >= 0) {
      throw unsupported(`source anchor differs for ${entry.file}`);
    }
    result = result.slice(0, at) + replacement.after + result.slice(at + replacement.before.length);
  }
  return result;
}

// Check every file before mutating any. Source fingerprints keep dependency
// upgrades from silently losing physical dispatch accounting.
async function applyPiRuntimePatches({ sourceDir = __dirname, resolvePackage = packageRoot } = {}) {
  const patchDir = path.join(sourceDir, 'pi-runtime-patches');
  const names = (await fs.readdir(patchDir)).filter(name => name.endsWith('.json')).sort();
  const changes = [];
  const roots = new Map();
  for (const name of names) {
    const entries = JSON.parse(await fs.readFile(path.join(patchDir, name), 'utf8'));
    for (const entry of entries) {
      const pkg = entry.package || '@earendil-works/pi-ai';
      if (!Object.hasOwn(versions, pkg)) throw unsupported('unrecognized patch package');
      if (!roots.has(pkg)) roots.set(pkg, await resolvePackage(pkg));
      const base = entry.package ? roots.get(pkg) : path.join(roots.get(pkg), 'dist');
      const target = path.resolve(base, entry.file);
      if (!target.startsWith(`${base}${path.sep}`)) throw unsupported('invalid patch target');
      const source = await fs.readFile(target, 'utf8');
      if (hash(source) === entry.sha256) {
        changes.push({ target, result: transform(source, entry) });
      } else {
        // Reverse the exact replacements to verify an already patched file.
        const reverse = { file: entry.file, replacements: [...entry.replacements].reverse().map(r => ({ before: r.after, after: r.before })) };
        let original;
        try { original = transform(source, reverse); } catch { throw unsupported(`source fingerprint differs for ${entry.file}`); }
        if (hash(original) !== entry.sha256) throw unsupported(`source fingerprint differs for ${entry.file}`);
      }
    }
  }
  if (!roots.has('@earendil-works/pi-ai')) roots.set('@earendil-works/pi-ai', await resolvePackage('@earendil-works/pi-ai'));
  const helperTarget = path.join(roots.get('@earendil-works/pi-ai'), 'dist', 'workbench-inference-hooks.js');
  const helper = await fs.readFile(path.join(sourceDir, 'pi-inference-hooks.mjs'), 'utf8');
  if (await fs.readFile(helperTarget, 'utf8').catch(() => null) !== helper) changes.push({ target: helperTarget, result: helper });
  for (const { target, result } of changes) {
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { await fs.writeFile(temporary, result); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  return { changedFiles: changes.length };
}

module.exports = { applyPiRuntimePatches };
