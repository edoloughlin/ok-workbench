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
function projectId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Project ID must start with a letter and use only letters, numbers, hyphens, or underscores');
  return value;
}
function projectTitle(value, id) {
  if (value === undefined || value === null || value === '') return id;
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\r\n\[\]]/.test(value)) throw new Error('Project title must be a short single line without brackets');
  return value.trim();
}
async function createProject({ id: requestedId, title: requestedTitle }) {
  const id = projectId(requestedId); const title = projectTitle(requestedTitle, id);
  const target = path.join(ROOT, id);
  if (await fs.lstat(target).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error(`Project already exists: ${id}`);
  const rootIndex = path.join(ROOT, 'index.md'); const link = `- [${title}](${id}/)`;
  let index = await fs.readFile(rootIndex, 'utf8').catch(error => error.code === 'ENOENT' ? '# Workspace\n' : Promise.reject(error));
  if (new RegExp(`\\]\\(${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}/?\\)`).test(index)) throw new Error(`Project is already registered: ${id}`);
  const template = process.env.OK_WORKBENCH_PROJECT_TEMPLATE || path.join(ROOT, 'templates', 'project');
  if (!(await fs.stat(template).then(stat => stat.isDirectory()).catch(() => false))) throw new Error('OKF project template is unavailable in this workspace');
  try {
    await fs.cp(template, target, { recursive: true, errorOnExist: true });
    const files = await listFiles(id);
    for (const relative of files) {
      const file = path.join(ROOT, relative); const content = await fs.readFile(file, 'utf8');
      if (content.includes('<Project>')) await fs.writeFile(file, content.replaceAll('<Project>', title), 'utf8');
    }
    index = `${index.replace(/\s*$/, '')}\n\n${link}\n`;
    await fs.writeFile(rootIndex, index, 'utf8');
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  return { id, path: id, location: `/workspace/${encodeURIComponent(id)}`, title, structure: 'OKF 0.2 project template' };
}

function setWorkspaceRoot(root) { ROOT = path.resolve(root); }
function startWorker() {
  const operations = { list_files: ({ path }) => listFiles(path || '.'), read_file: ({ path }) => readFile(path), search_files: ({ query }) => searchFiles(query), apply_patch: applyPatch, create_project: createProject };
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
module.exports = { setWorkspaceRoot, listFiles, readFile, searchFiles, applyPatch, createProject, startWorker };

if (require.main === module) startWorker();
