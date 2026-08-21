#!/usr/bin/env node

// Deliberately small JSONL file-tool server. The supervisor runs this process
// inside Bubblewrap with the selected project mounted at /workspace. Do not add
// shell execution here: future command execution needs a separate approval and
// resource-control policy.
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { constants } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

let ROOT = path.resolve(process.env.OK_WORKSPACE_ROOT || process.env.OKF_WORKSPACE_ROOT || '/workspace');
const MAX_READ = 256 * 1024;
const MAX_RESULTS = 200;
const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_TOOL_ARGUMENTS = 32;
const MAX_TOOL_ARGUMENT_LENGTH = 4 * 1024;
const DEFAULT_TOOL_TIMEOUT_SECONDS = 30;
const MAX_TOOL_TIMEOUT_SECONDS = 600;
const MAX_TOOL_MANIFEST = 16 * 1024;
const MAX_TOOL_ENVIRONMENT = 16;
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
  // macOS commonly presents temporary directories through /var even though
  // realpath returns /private/var. Compare canonical paths so that alias is
  // not mistaken for an escape, while still rejecting a real symlink escape.
  const root = await fs.realpath(ROOT);
  let ancestor = write ? path.dirname(target) : target; let real = null;
  while (!real) { real = await fs.realpath(ancestor).catch(() => null); if (!real) { const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error('Cannot resolve workspace path'); ancestor = parent; } }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error('Symlink escapes workspace');
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
function toolRuntime(shebang) {
  const command = shebang.trim().replace(/^#!\s*/, '');
  if (/^(?:\/usr\/bin\/env\s+)?python3(?:\s|$)/.test(command)) return 'python3';
  if (/^(?:\/usr\/bin\/env\s+)?(?:node|nodejs)(?:\s|$)/.test(command)) return 'nodejs';
  return null;
}
function toolPath(relative) {
  const parts = safeRelative(relative).split('/');
  const allowed = (parts.length === 2 && parts[0] === 'tools') || (parts.length === 3 && parts[1] === 'tools');
  if (!allowed || !parts.at(-1) || parts.at(-1).startsWith('.')) throw new Error('Tools must be direct files in tools/ or <project>/tools/');
  return parts.join('/');
}
async function workspaceTool(relative) {
  const safe = toolPath(relative); const { target } = await targetFor(safe);
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Tool is not a regular file');
  if (!(info.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH))) throw new Error('Tool is not executable');
  if (info.size > MAX_READ) throw new Error('Tool is too large');
  const firstLine = (await fs.readFile(target, 'utf8')).split(/\r?\n/, 1)[0]; const runtime = toolRuntime(firstLine);
  if (!runtime) throw new Error('Tool must begin with a Python 3 or Node.js shebang');
  return { path: safe, target, runtime };
}
function isToolFile(relative) {
  const parts = safeRelative(relative).split('/');
  return (parts.length === 2 && parts[0] === 'tools') || (parts.length === 3 && parts[1] === 'tools');
}
function toolEnvironmentNames(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOL_ENVIRONMENT || value.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Tool manifest environment must be an array of up to 16 variable names');
  return [...new Set(value)];
}
function toolTimeoutSeconds(value) {
  if (value === undefined) return DEFAULT_TOOL_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TOOL_TIMEOUT_SECONDS) throw new Error(`Tool manifest timeoutSeconds must be an integer from 1 to ${MAX_TOOL_TIMEOUT_SECONDS}`);
  return value;
}
async function workspaceToolPolicy(relative) {
  const tool = await workspaceTool(relative); const extension = path.posix.extname(tool.path);
  const manifestPaths = [...new Set([`${extension ? tool.path.slice(0, -extension.length) : tool.path}.tool.json`, `${tool.path}.tool.json`])];
  const manifests = [];
  for (const manifestPath of manifestPaths) {
    const { target } = await targetFor(manifestPath); const info = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info) manifests.push({ manifestPath, target, info });
  }
  if (manifests.length > 1) throw new Error('Tool has conflicting manifest files');
  const [{ target, info } = {}] = manifests;
  if (!info) return { path: tool.path, runtime: tool.runtime, manifestPath: null, manifest: null, environment: [], network: false, timeoutSeconds: DEFAULT_TOOL_TIMEOUT_SECONDS };
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TOOL_MANIFEST) throw new Error('Tool manifest must be a regular JSON file under 16 KiB');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(target, 'utf8')); } catch { throw new Error('Tool manifest is not valid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => key !== 'environment' && key !== 'network' && key !== 'timeoutSeconds')) throw new Error('Tool manifest may contain only environment, network, and timeoutSeconds');
  if (manifest.network !== undefined && typeof manifest.network !== 'boolean') throw new Error('Tool manifest network must be true or false');
  return { path: tool.path, runtime: tool.runtime, manifestPath: manifests[0].manifestPath, manifest, environment: toolEnvironmentNames(manifest.environment), network: manifest.network === true, timeoutSeconds: toolTimeoutSeconds(manifest.timeoutSeconds) };
}
async function listWorkspaceTools() {
  const directories = ['tools'];
  for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'tools') directories.push(path.posix.join(entry.name, 'tools'));
  const tools = []; const diagnostics = [];
  for (const directory of directories) {
    const target = path.join(ROOT, directory);
    const entries = await fs.readdir(target, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const metadata = entries.filter(entry => entry.isFile() && entry.name.endsWith('.tool.json'));
    const usedMetadata = new Set();
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.') || entry.name.endsWith('.tool.json')) continue;
      const relative = path.posix.join(directory, entry.name);
      try {
        const tool = await workspaceToolPolicy(relative); tools.push(tool); if (tool.manifestPath) usedMetadata.add(path.posix.basename(tool.manifestPath));
      } catch (error) {
        try { await workspaceTool(relative); diagnostics.push({ path: relative, error: error.message }); } catch { /* Non-tools do not need a diagnostic. */ }
      }
    }
    for (const entry of metadata) if (!usedMetadata.has(entry.name)) {
      const base = entry.name.slice(0, -'.tool.json'.length);
      const candidates = entries.filter(candidate => candidate.isFile() && !candidate.name.endsWith('.tool.json') && (candidate.name === base || candidate.name.startsWith(`${base}.`)));
      if (candidates.length === 1) {
        const scriptPath = path.posix.join(directory, candidates[0].name);
        try { await workspaceTool(scriptPath); diagnostics.push({ path: path.posix.join(directory, entry.name), error: 'Tool metadata was not selected; check for a conflicting manifest' }); }
        catch (error) { diagnostics.push({ path: path.posix.join(directory, entry.name), error: `Matching script ${candidates[0].name} is not runnable: ${error.message}` }); }
      } else diagnostics.push({ path: path.posix.join(directory, entry.name), error: candidates.length ? 'Tool metadata matches multiple scripts in this directory' : 'Tool metadata does not match a script in this directory' });
    }
  }
  return { tools: tools.slice(0, MAX_RESULTS), diagnostics: diagnostics.slice(0, MAX_RESULTS) };
}
function toolArguments(argumentsList) {
  if (argumentsList === undefined) return [];
  if (!Array.isArray(argumentsList) || argumentsList.length > MAX_TOOL_ARGUMENTS || argumentsList.some(value => typeof value !== 'string' || value.length > MAX_TOOL_ARGUMENT_LENGTH || value.includes('\0'))) throw new Error('Tool arguments must be 0–32 short strings');
  return argumentsList;
}
async function runWorkspaceTool({ path: relative, arguments: argumentsList }) {
  const tool = await workspaceToolPolicy(relative); const args = toolArguments(argumentsList);
  const command = tool.runtime === 'python3' ? 'python3' : process.execPath;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [tool.target, ...args], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const capture = (current, chunk) => `${current}${chunk}`.slice(0, MAX_TOOL_OUTPUT);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, tool.timeoutSeconds * 1000);
    child.once('error', error => { clearTimeout(timeout); reject(new Error(`Tool could not start: ${error.message}`)); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return reject(new Error(`Tool timed out after ${tool.timeoutSeconds} seconds`));
      resolve({ path: tool.path, runtime: tool.runtime, arguments: args, exitCode: code, signal: signal || null, stdout, stderr, ok: code === 0 && !signal });
    });
  });
}
async function applyPatch({ path: relative, content }) {
  if (typeof content !== 'string' || content.length > 1024 * 1024) throw new Error('Replacement content is required and must be under 1 MiB');
  if (isToolFile(relative) || safeRelative(relative).endsWith('.tool.json')) throw new Error('Workspace tools and their manifests are managed outside agent file updates');
  const { safe, target } = await targetFor(relative, true); await fs.mkdir(path.dirname(target), { recursive: true });
  let existing = null;
  try { existing = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a symbolic link');
  await fs.writeFile(target, content, 'utf8'); return { path: safe, bytes: Buffer.byteLength(content) };
}
async function directoryExists(target) { return fs.stat(target).then(value => value.isDirectory()).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)); }
async function applyProjectUpdate({ changes }) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 64) throw new Error('Provide 1–64 workspace file changes');
  const prepared = new Map();
  for (const change of changes) {
    if (!change || typeof change.content !== 'string' || change.content.length > 1024 * 1024) throw new Error('Each workspace change needs text content under 1 MiB');
    const { safe } = await targetFor(change.path, true);
    if (prepared.has(safe)) throw new Error(`Duplicate workspace change: ${safe}`);
    prepared.set(safe, change.content);
  }
  const projects = new Set();
  for (const safe of prepared.keys()) {
    const parts = safe.split('/'); if (parts.length < 2) continue;
    const project = parts[0];
    if (prepared.has(`${project}/index.md`) || await fs.stat(path.join(ROOT, project, 'index.md')).then(item => item.isFile()).catch(() => false)) projects.add(project);
    for (let directory = parts.slice(0, -1).join('/'); directory; directory = directory.split('/').slice(0, -1).join('/')) {
      if (!(await directoryExists(path.join(ROOT, directory))) && !prepared.has(`${directory}/index.md`)) throw new Error(`New directory ${directory} requires ${directory}/index.md in the same update`);
    }
  }
  for (const project of projects) for (const name of ['index.md', 'log.md', 'status.md']) if (!prepared.has(`${project}/${name}`)) throw new Error(`OKF project update requires ${project}/${name} in the same update`);
  const written = [];
  for (const [safe, content] of prepared) written.push(await applyPatch({ path: safe, content }));
  return { paths: written.map(item => item.path), bytes: written.reduce((sum, item) => sum + item.bytes, 0) };
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
  const operations = { list_files: ({ path }) => listFiles(path || '.'), read_file: ({ path }) => readFile(path), search_files: ({ query }) => searchFiles(query), list_workspace_tools: listWorkspaceTools, workspace_tool_policy: ({ path }) => workspaceToolPolicy(path), run_workspace_tool: runWorkspaceTool, apply_project_update: applyProjectUpdate, create_project: createProject };
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // The launcher waits for this acknowledgement before exposing file tools.
  // A spawn event alone does not prove that the OS sandbox accepted the worker.
  send({ ready: true });
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
module.exports = { setWorkspaceRoot, listFiles, readFile, searchFiles, listWorkspaceTools, workspaceToolPolicy, runWorkspaceTool, applyPatch, applyProjectUpdate, createProject, startWorker };

if (require.main === module) startWorker();
