const fs = require('node:fs/promises');
const fsNative = require('node:fs');
const path = require('node:path');
const { documentDefinitions } = require('./document-definitions.js');

const CACHE_TTL_MS = 5 * 60_000; // recover from missed filesystem notifications
const MAX_PROJECTS = 32;
const MAX_WATCHED_DIRS = 256; // fall back to TTL for very large trees
const projects = new Map();

function closeWatchers(state) {
  for (const watcher of state.watchers) watcher.close();
  state.watchers = [];
}

// Index ordinary Markdown files in priority order; never follow symlinks.
async function buildIndex(root, state) {
  closeWatchers(state);
  state.dirty = false;
  const files = [];
  let visited = 0;
  async function visit(directory, parts) {
    if (visited >= 3000) return;
    if (state.watchers.length < MAX_WATCHED_DIRS) {
      try {
        const watcher = fsNative.watch(directory, () => { state.dirty = true; });
        watcher.on('error', () => { state.dirty = true; });
        watcher.unref();
        state.watchers.push(watcher);
      } catch { /* TTL handles directories that cannot be watched. */ }
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (++visited > 3000) break;
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relative = [...parts, entry.name];
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(relative);
    }
  }
  await visit(root, []);
  // Root first, then shallowest subdirectories, with archive trees last.
  files.sort((a, b) => {
    const rank = parts => parts.slice(0, -1).some(part => part.toLowerCase() === 'archive') ? 2 : parts.length === 1 ? 0 : 1;
    return rank(a) - rank(b) || a.length - b.length || a.join('/').localeCompare(b.join('/'), 'en');
  });
  const index = new Map();
  for (const parts of files) {
    const file = path.join(root, ...parts);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) continue;
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    for (const entry of documentDefinitions(text).entries) {
      const key = entry.key.toLowerCase();
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ definition: entry.definition, file: parts.join('/'), absolute: file });
    }
  }
  return index;
}

async function projectIndex(root, state) {
  if (state.index && !state.dirty && state.expires > Date.now()) return state.index;
  if (!state.promise) {
    state.promise = (async () => {
      // If a file changes while indexing, retry before serving the new index.
      for (let attempt = 0; attempt < 2; attempt++) {
        const index = await buildIndex(root, state);
        if (!state.dirty || attempt === 1) {
          state.index = index;
          state.expires = Date.now() + CACHE_TTL_MS;
          return index;
        }
      }
    })();
    state.promise.catch(() => { state.dirty = true; closeWatchers(state); });
    state.promise.finally(() => { state.promise = null; }).catch(() => {});
  }
  return state.promise;
}

async function findProjectDefinition(projectRoot, currentFile, key) {
  if (typeof key !== 'string' || !key || key.length > 100) throw new Error('Invalid definition key');
  let state = projects.get(projectRoot);
  if (!state) {
    state = { index: null, promise: null, expires: 0, dirty: true, watchers: [] };
    projects.set(projectRoot, state);
  } else {
    projects.delete(projectRoot);
    projects.set(projectRoot, state);
  }
  if (projects.size > MAX_PROJECTS) {
    const oldest = projects.keys().next().value;
    const evicted = projects.get(oldest);
    projects.delete(oldest);
    closeWatchers(evicted);
  }
  const index = await projectIndex(projectRoot, state);
  if (projects.get(projectRoot) !== state) closeWatchers(state);
  const matches = index.get(key.toLowerCase())?.filter(item => item.absolute !== currentFile) || [];
  return matches.length ? { definition: matches[0].definition, file: matches[0].file, multiple: matches.length > 1 } : null;
}
module.exports = { findProjectDefinition };
