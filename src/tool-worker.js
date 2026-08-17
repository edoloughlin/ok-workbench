#!/usr/bin/env node

// Deliberately small JSONL file-tool server. The supervisor runs this process
// inside Bubblewrap with the selected project mounted at /workspace. Do not add
// shell execution here: future command execution needs a separate approval and
// resource-control policy.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

let ROOT = path.resolve(process.env.OK_WORKSPACE_ROOT || process.env.OKF_WORKSPACE_ROOT || '/workspace');
const MAX_READ = 256 * 1024;
const MAX_RESULTS = 200;
const DENIED = new Set(['.git', 'id_rsa', 'id_ed25519', 'known_hosts', 'credentials']);

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('A relative path is required');
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw new Error('Path is outside the workspace');
  if (normalized.split('/').some(part => DENIED.has(part) || part.startsWith('.git') || part.startsWith('.env') || /\.(?:pem|key|p12|pfx)$/i.test(part))) throw new Error('Path is not available to the agent');
  return normalized;
}
async function targetFor(relative, write = false) {
  const safe = safeRelative(relative); const target = path.resolve(ROOT, safe);
  if (!target.startsWith(`${ROOT}${path.sep}`)) throw new Error('Path is outside the workspace');
  let ancestor = write ? path.dirname(target) : target; let real = null;
  while (!real) { real = await fs.realpath(ancestor).catch(() => null); if (!real) { const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error('Cannot resolve workspace path'); ancestor = parent; } }
  if (real !== ROOT && !real.startsWith(`${ROOT}${path.sep}`)) throw new Error('Symlink escapes workspace');
  return { safe, target };
}
async function listFiles(relative = '.') {
  const start = relative === '.' ? { safe: '', target: ROOT } : await targetFor(relative); const output = [];
  async function visit(directory, prefix) {
    if (output.length >= MAX_RESULTS) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || DENIED.has(entry.name)) continue;
      const child = path.join(directory, entry.name); const childRelative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) output.push(childRelative);
      if (output.length >= MAX_RESULTS) return;
    }
  }
  await visit(start.target, start.safe); return output;
}
async function readFile(relative) {
  const { safe, target } = await targetFor(relative); const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Path is not a file'); if (stat.size > MAX_READ) throw new Error('File is too large to read');
  const content = await fs.readFile(target, 'utf8'); if (content.includes('\0')) throw new Error('Binary files are not available'); return { path: safe, content };
}
async function searchFiles(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 256) throw new Error('A short search query is required');
  const matches = [];
  for (const relative of await listFiles('.')) {
    if (matches.length >= MAX_RESULTS) break;
    try { const { content } = await readFile(relative); const lines = content.split(/\r?\n/); lines.forEach((line, index) => { if (matches.length < MAX_RESULTS && line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: relative, line: index + 1, text: line.slice(0, 500) }); }); } catch { /* skip binary/large/unreadable files */ }
  }
  return matches;
}
async function applyPatch({ path: relative, content }) {
  if (typeof content !== 'string' || content.length > 1024 * 1024) throw new Error('Replacement content is required and must be under 1 MiB');
  const { safe, target } = await targetFor(relative, true); await fs.mkdir(path.dirname(target), { recursive: true });
  let existing = null;
  try { existing = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a symbolic link');
  await fs.writeFile(target, content, 'utf8'); return { path: safe, bytes: Buffer.byteLength(content) };
}

function setWorkspaceRoot(root) { ROOT = path.resolve(root); }
module.exports = { setWorkspaceRoot, listFiles, readFile, searchFiles, applyPatch };

if (require.main === module) {
  const operations = { list_files: ({ path }) => listFiles(path || '.'), read_file: ({ path }) => readFile(path), search_files: ({ query }) => searchFiles(query), apply_patch: applyPatch };
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // A caller can close stdin immediately after its final JSONL request. Keep
  // the event loop alive until the asynchronous filesystem operation replies.
  const keepAlive = setInterval(() => {}, 1_000);
  let pending = 0;
  let inputClosed = false;
  input.on('close', () => { inputClosed = true; if (!pending) keepAlive.unref(); });
  input.on('line', async line => {
    pending++; keepAlive.ref();
    let request;
    try {
      request = JSON.parse(line); const operation = operations[request.operation]; if (!operation) throw new Error('Unknown workspace operation');
      send({ id: request.id, ok: true, result: await operation(request.params || {}) });
    } catch (error) { send({ id: request?.id, ok: false, error: error.message }); }
    finally { pending--; if (!pending && inputClosed) keepAlive.unref(); }
  });
}
