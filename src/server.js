#!/usr/bin/env node

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 3477);
// Resolve the bundle from this project's location so both `node server.js` and
// `node ok-workbench/server.js` work from a checked-out bundle.
const LEGACY_BUNDLE_ROOT = process.env.AGENTS_BUNDLE_ROOT;
const LEGACY_OKF_BUNDLE_ROOT = process.env.OKF_WORKSPACE_ROOT;
let BUNDLE_ROOT = path.resolve(process.env.OK_WORKSPACE_ROOT || LEGACY_OKF_BUNDLE_ROOT || LEGACY_BUNDLE_ROOT || path.join(process.cwd(), 'workspace'));
const COMMON_FILES = ['AGENTS.md', 'README.md', 'index.md', 'status.md', 'log.md'];
const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
};
const CODE_TYPES = {
  '.py': ['python', 'Python'], '.js': ['javascript', 'JavaScript'], '.mjs': ['javascript', 'JavaScript module'],
  '.cjs': ['javascript', 'CommonJS'], '.jsx': ['javascript', 'JSX'], '.ts': ['typescript', 'TypeScript'], '.tsx': ['typescript', 'TSX'],
  '.json': ['json', 'JSON'], '.jsonl': ['json', 'JSON Lines'], '.css': ['css', 'CSS'], '.scss': ['css', 'SCSS'],
  '.html': ['html', 'HTML'], '.htm': ['html', 'HTML'], '.xml': ['html', 'XML'], '.svg': ['html', 'SVG'],
  '.yml': ['yaml', 'YAML'], '.yaml': ['yaml', 'YAML'], '.toml': ['toml', 'TOML'], '.ini': ['ini', 'INI'],
  '.conf': ['ini', 'configuration'], '.sh': ['shell', 'shell'], '.bash': ['shell', 'Bash'], '.zsh': ['shell', 'Z shell'],
  '.fish': ['shell', 'fish shell'], '.sql': ['sql', 'SQL'], '.go': ['go', 'Go'], '.rs': ['rust', 'Rust'],
  '.java': ['java', 'Java'], '.c': ['c', 'C'], '.h': ['c', 'C header'], '.cc': ['cpp', 'C++'], '.cpp': ['cpp', 'C++'],
  '.hpp': ['cpp', 'C++ header'], '.rb': ['ruby', 'Ruby'], '.php': ['php', 'PHP'], '.pl': ['perl', 'Perl'],
  '.diff': ['diff', 'diff'], '.patch': ['diff', 'patch'], '.csv': ['csv', 'CSV'], '.env': ['ini', 'environment'],
  '.gitignore': ['gitignore', 'gitignore'], '.log': ['plaintext', 'log'], '.txt': ['plaintext', 'plain text']
};
const NAMED_CODE_TYPES = { Makefile: ['makefile', 'Makefile'], Dockerfile: ['dockerfile', 'Dockerfile'] };
const MAX_TEXT_PREVIEW = 2 * 1024 * 1024;
const MAX_JSON_BODY = 1024 * 1024;
function chatStateDir() {
  const fallback = path.join(os.homedir(), '.local', 'state', 'ok-workbench', 'chat');
  const configured = process.env.OK_WORKBENCH_STATE_DIR || process.env.OKF_WORKBENCH_STATE_DIR || process.env.AGENTS_BROWSER_STATE_DIR;
  if (!configured) return fallback;
  const resolved = path.resolve(configured);
  const agentsRoot = path.join(os.homedir(), 'workspace');
  // State contains chat history and browser-owned provider credentials. Never
  // permit it in the checked-out knowledge bundle or a sibling agent repo.
  return resolved === agentsRoot || resolved.startsWith(`${agentsRoot}${path.sep}`) ? fallback : resolved;
}
const CHAT_STATE_DIR = chatStateDir();
const CHAT_CSRF = crypto.randomBytes(32).toString('base64url');
const DIFF_TOKENS = new Map();
const GIT_RECOVERY = new Map();
const ACTIVE_TURNS = new Map();
const THREAD_WRITES = new Map();
const AUTH_FLOWS = new Map();
let ignoreRulesPromise;

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }
function logError(...args) { console.error(`[${new Date().toISOString()}]`, ...args); }

function respond(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function configDirectory(name = 'ok-workbench') {
  return process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, name) : path.join(os.homedir(), '.config', name);
}
async function configuredWorkspaceRoot() {
  for (const directory of [configDirectory(), configDirectory('okf-workbench')]) {
    try {
      const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
      if (typeof config.workspaceRoot === 'string') return config.workspaceRoot;
    } catch { /* try the next compatible location */ }
  }
  return null;
}
async function resolveWorkspaceRoot() {
  const explicit = process.env.OK_WORKSPACE_ROOT || LEGACY_OKF_BUNDLE_ROOT || LEGACY_BUNDLE_ROOT;
  if (explicit) return path.resolve(explicit);
  const configured = await configuredWorkspaceRoot();
  if (configured) return path.resolve(configured);
  const local = path.resolve(process.cwd(), 'workspace');
  if (await isDirectory(local)) return local;
  return path.join(os.homedir(), 'workspace');
}

function safePath(routePath) {
  const relative = routePath.replace(/^\/(?:workspace|agents)\/?/, '');
  const target = path.resolve(BUNDLE_ROOT, relative || '.');
  return target === BUNDLE_ROOT || target.startsWith(`${BUNDLE_ROOT}${path.sep}`) ? target : null;
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function isDirectory(file) { try { return (await fs.stat(file)).isDirectory(); } catch { return false; } }
async function bundlePath(target) {
  try {
    const [root, resolved] = await Promise.all([fs.realpath(BUNDLE_ROOT), fs.realpath(target)]);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
  } catch { return null; }
}

function publicPath(file) {
  return `/workspace/${path.relative(BUNDLE_ROOT, file).split(path.sep).map(encodeURIComponent).join('/')}`.replace(/\/$/, '') || '/workspace';
}

function titleFromMarkdown(text, fallback) {
  const heading = text.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
}

function globRegex(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') { source += '.*'; i++; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return source;
}

async function ignoreRules() {
  if (!ignoreRulesPromise) ignoreRulesPromise = (async () => {
    const file = path.join(BUNDLE_ROOT, '.gitignore');
    if (!(await exists(file))) return [];
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    return lines.map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
      const negated = line.startsWith('!');
      let pattern = negated ? line.slice(1) : line;
      const directory = pattern.endsWith('/');
      if (directory) pattern = pattern.slice(0, -1);
      const anchored = pattern.startsWith('/');
      if (anchored) pattern = pattern.slice(1);
      const hasSlash = pattern.includes('/');
      const prefix = anchored || hasSlash ? '^' : '(?:^|/)';
      const suffix = directory ? '(?:/.*)?$' : '$';
      return { negated, regex: new RegExp(`${prefix}${globRegex(pattern)}${suffix}`) };
    });
  })();
  return ignoreRulesPromise;
}

async function isIgnored(file) {
  const relative = path.relative(BUNDLE_ROOT, file).split(path.sep).join('/');
  let ignored = false;
  for (const rule of await ignoreRules()) if (rule.regex.test(relative)) ignored = !rule.negated;
  return ignored;
}

function navigationLabel(label, type) {
  return type === 'directory' ? label.replace(/\/+$/, '') : label;
}

function shebangType(firstLine) {
  if (!firstLine.startsWith('#!')) return null;
  if (/python/i.test(firstLine)) return ['python', 'Python script'];
  if (/(?:node|deno)/i.test(firstLine)) return ['javascript', 'JavaScript executable'];
  if (/(?:bash|zsh|fish|\bsh\b)/i.test(firstLine)) return ['shell', 'shell script'];
  if (/ruby/i.test(firstLine)) return ['ruby', 'Ruby script'];
  if (/perl/i.test(firstLine)) return ['perl', 'Perl script'];
  return ['plaintext', 'text executable'];
}

function appearsText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return false;
  let controls = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls++;
  return sample.length === 0 || controls / sample.length < 0.02;
}

function classifyFile(target, buffer) {
  const name = path.basename(target);
  const ext = path.extname(target).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  if (ext === '.md') return { kind: 'markdown', language: 'markdown', fileType: 'Markdown', mime: 'text/markdown; charset=utf-8' };
  if (mime.startsWith('image/')) return { kind: 'media', mediaType: 'image', fileType: mime.slice(6).toUpperCase(), mime };
  if (mime.startsWith('audio/')) return { kind: 'media', mediaType: 'audio', fileType: `${mime.slice(6).toUpperCase()} audio`, mime };
  if (mime.startsWith('video/')) return { kind: 'media', mediaType: 'video', fileType: `${mime.slice(6).toUpperCase()} video`, mime };
  if (ext === '.pdf') return { kind: 'media', mediaType: 'pdf', fileType: 'PDF document', mime };
  const firstLine = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').split(/\r?\n/, 1)[0];
  const codeType = CODE_TYPES[ext] || NAMED_CODE_TYPES[name] || shebangType(firstLine);
  if (codeType || appearsText(buffer)) {
    const [language, fileType] = codeType || ['plaintext', 'plain text'];
    return { kind: 'code', language, fileType, mime: MIME[ext] || 'text/plain; charset=utf-8' };
  }
  return { kind: 'binary', fileType: ext ? `${ext.slice(1).toUpperCase()} file` : 'binary file', mime };
}

function linksFromIndex(markdown, folder) {
  const found = [];
  const seen = new Set();
  const re = /(?:^|\n)\s*(?:[-*+]\s+|\d+\.\s+)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(re)) {
    const href = match[2];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const candidate = path.resolve(folder, decodeURIComponent(href.split('#')[0]));
    if (!candidate.startsWith(`${folder}${path.sep}`) && candidate !== folder) continue;
    const route = publicPath(candidate);
    if (!seen.has(route)) { seen.add(route); found.push({ label: match[1], path: route }); }
  }
  return found;
}

async function navigationTree(folder, isRoot = false, depth = 0) {
  if (depth > 12) return [];
  const indexFile = path.join(folder, 'index.md');
  const index = (await exists(indexFile)) ? await fs.readFile(indexFile, 'utf8') : '';
  const indexedLinks = linksFromIndex(index, folder);
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
    if (isRoot && COMMON_FILES.includes(entry.name)) continue;

    const fullPath = path.join(folder, entry.name);
    if (await isIgnored(fullPath)) continue;
    const route = publicPath(fullPath);
    const exactIndex = indexedLinks.findIndex(link => link.path === route);

    if (entry.isDirectory()) {
      candidates.push({
        type: 'directory',
        label: navigationLabel(exactIndex >= 0 ? indexedLinks[exactIndex].label : entry.name, 'directory'),
        path: route,
        children: await navigationTree(fullPath, false, depth + 1)
      });
    } else if (entry.isFile()) {
      candidates.push({
        type: 'file',
        label: exactIndex >= 0 ? indexedLinks[exactIndex].label : entry.name,
        path: route
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

async function isProjectDirectory(directory) {
  return (await isDirectory(directory)) && !(await isIgnored(directory));
}

async function projectData(requested) {
  let requestedPath = safePath(requested || '/workspace');
  requestedPath = requestedPath && await bundlePath(requestedPath);
  if (!requestedPath || !(await exists(requestedPath))) throw new Error('Project not found');
  if (!(await isDirectory(requestedPath))) requestedPath = path.dirname(requestedPath);

  const relativeParts = path.relative(BUNDLE_ROOT, requestedPath).split(path.sep).filter(Boolean);
  const projectRoot = relativeParts.length ? path.join(BUNDLE_ROOT, relativeParts[0]) : BUNDLE_ROOT;
  const bundleIndexFile = path.join(BUNDLE_ROOT, 'index.md');
  const bundleIndex = (await exists(bundleIndexFile)) ? await fs.readFile(bundleIndexFile, 'utf8') : '';
  const bundleLinks = linksFromIndex(bundleIndex, BUNDLE_ROOT);
  const projects = [{ name: 'workspace', path: '/workspace', label: 'workspace / bundle root' }];
  for (const link of bundleLinks) {
    let target = safePath(link.path);
    // An index commonly links to a project's index.md rather than its
    // directory. Both forms declare the same top-level project.
    if (target && path.basename(target) === 'index.md') target = path.dirname(target);
    if (!target || path.dirname(target) !== BUNDLE_ROOT || !(await isProjectDirectory(target))) continue;
    const projectPath = publicPath(target);
    if (!projects.some(project => project.path === projectPath)) projects.push({ name: path.basename(target), path: projectPath, label: navigationLabel(link.label, 'directory') });
  }
  // Every top-level, non-ignored directory is a project. Index links are
  // optional: they control prose and, when present, display labels.
  const topLevel = await fs.readdir(BUNDLE_ROOT, { withFileTypes: true });
  for (const entry of topLevel.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const target = path.join(BUNDLE_ROOT, entry.name);
    if (!(await isProjectDirectory(target))) continue;
    const projectPath = publicPath(target);
    if (!projects.some(project => project.path === projectPath)) {
      const indexFile = path.join(target, 'index.md');
      const label = (await exists(indexFile)) ? titleFromMarkdown(await fs.readFile(indexFile, 'utf8'), entry.name) : entry.name;
      projects.push({ name: entry.name, path: projectPath, label });
    }
  }
  const projectIndexFile = path.join(projectRoot, 'index.md');
  const projectIndex = (await exists(projectIndexFile)) ? await fs.readFile(projectIndexFile, 'utf8') : '';
  const contextIndexFile = path.join(requestedPath, 'index.md');
  const contextIndex = (await exists(contextIndexFile)) ? await fs.readFile(contextIndexFile, 'utf8') : '';
  const common = [];
  for (const name of COMMON_FILES) if (await exists(path.join(projectRoot, name))) common.push({ label: name, path: publicPath(path.join(projectRoot, name)) });
  const projectFiles = await fs.readdir(projectRoot, { withFileTypes: true });
  const projectLinks = linksFromIndex(projectIndex, projectRoot);
  const stats = { documents: projectFiles.filter(item => item.isFile() && /\.md$/i.test(item.name)).length, folders: projectFiles.filter(item => item.isDirectory()).length, indexed: projectLinks.length };
  const isBundleRoot = projectRoot === BUNDLE_ROOT;
  const tree = isBundleRoot ? [] : await navigationTree(projectRoot, true);
  const catalog = isBundleRoot ? projects.slice(1) : [];

  const projectName = path.relative(BUNDLE_ROOT, projectRoot) || 'workspace';
  const projectTitle = titleFromMarkdown(projectIndex, path.basename(projectRoot));
  const selectedParts = path.relative(projectRoot, requestedPath).split(path.sep).filter(Boolean);
  const breadcrumbs = [{ label: projectTitle, path: publicPath(projectRoot) }];
  let breadcrumbPath = projectRoot;
  for (const part of selectedParts) {
    breadcrumbPath = path.join(breadcrumbPath, part);
    breadcrumbs.push({ label: part, path: publicPath(breadcrumbPath) });
  }

  return {
    project: { name: projectName, path: publicPath(projectRoot), title: projectTitle },
    context: { name: path.relative(projectRoot, requestedPath) || projectName, path: publicPath(requestedPath), title: titleFromMarkdown(contextIndex, path.basename(requestedPath)), breadcrumbs },
    projects,
    catalog,
    common,
    tree,
    stats
  };
}

async function documentData(requested) {
  let target = safePath(requested);
  target = target && await bundlePath(target);
  if (!target) throw new Error('Not found');
  if (await isDirectory(target)) target = path.join(target, 'index.md');
  target = await bundlePath(target);
  if (!target || !(await exists(target))) throw new Error('Not found');
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Not found');
  const buffer = await fs.readFile(target);
  const classification = classifyFile(target, buffer);
  const base = { ...classification, name: path.basename(target), path: publicPath(target), url: `/asset${publicPath(target)}`, size: stat.size };
  if (classification.kind === 'markdown') {
    const text = buffer.toString('utf8');
    return { ...base, title: titleFromMarkdown(text, path.basename(target)), text };
  }
  if (classification.kind === 'code') {
    if (stat.size > MAX_TEXT_PREVIEW) return { ...base, kind: 'binary', fileType: `${classification.fileType} · preview too large` };
    return { ...base, title: path.basename(target), text: buffer.toString('utf8') };
  }
  return { ...base, title: path.basename(target) };
}

async function asset(res, pathname) {
  const target = safePath(pathname);
  const resolved = target && await bundlePath(target);
  if (!resolved || !(await exists(resolved)) || await isDirectory(resolved)) return respond(res, 404, 'Not found', 'text/plain');
  const buffer = await fs.readFile(resolved);
  const classification = classifyFile(resolved, buffer);
  res.writeHead(200, {
    'content-type': classification.mime,
    'cache-control': 'no-store',
    'x-filetype': classification.language || classification.mediaType || classification.fileType,
    'content-disposition': `inline; filename="${path.basename(resolved).replace(/"/g, '')}"`
  });
  res.end(buffer);
}

function json(res, status, value) { return respond(res, status, JSON.stringify(value)); }

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON request body'); }
}

function assertChatRequest(req) {
  const host = String(req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Chat is available only on the local server');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['x-ok-workbench-csrf'] !== CHAT_CSRF && req.headers['x-okf-workbench-csrf'] !== CHAT_CSRF && req.headers['x-agents-browser-csrf'] !== CHAT_CSRF) throw new Error('Invalid chat request token');
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin)) throw new Error('Untrusted request origin');
  }
}

function projectRootForId(projectId) {
  if (projectId === 'workspace') return BUNDLE_ROOT;
  if (!projectId || /[\\/\0]/.test(projectId)) throw new Error('Invalid project');
  const root = path.resolve(BUNDLE_ROOT, projectId);
  if (!root.startsWith(`${BUNDLE_ROOT}${path.sep}`)) throw new Error('Invalid project');
  return root;
}

function newProjectId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Project ID must start with a letter and use only letters, numbers, hyphens, or underscores');
  return value;
}
function newProjectTitle(value, id) {
  if (value === undefined || value === null || value === '') return id;
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\r\n\[\]]/.test(value)) throw new Error('Project name must be a short single line without brackets');
  return value.trim();
}
function newProjectDescription(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 280 || /[\r\n]/.test(value)) throw new Error('Project description must be a single line of 280 characters or fewer');
  return value.trim();
}
async function createWorkspaceProject({ id: requestedId, title: requestedTitle, description: requestedDescription }) {
  const id = newProjectId(requestedId); const title = newProjectTitle(requestedTitle, id); const description = newProjectDescription(requestedDescription);
  const target = path.join(BUNDLE_ROOT, id);
  if (await fs.lstat(target).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error(`Project already exists: ${id}`);
  const rootIndex = path.join(BUNDLE_ROOT, 'index.md'); const link = `- [${title}](${id}/)`;
  let index = await fs.readFile(rootIndex, 'utf8').catch(error => error.code === 'ENOENT' ? '# Workspace\n' : Promise.reject(error));
  if (new RegExp(`\\]\\(${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}/?\\)`).test(index)) throw new Error(`Project is already registered: ${id}`);
  const template = path.join(__dirname, '..', 'seed', 'workspace', 'templates', 'project');
  if (!(await isDirectory(template))) throw new Error('OKF project template is unavailable');
  try {
    await fs.cp(template, target, { recursive: true, errorOnExist: true });
    const entries = await fs.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(target, entry.name); const content = await fs.readFile(file, 'utf8');
      let updated = content.replaceAll('<Project>', title);
      if (description && entry.name === 'index.md') updated = updated.replace('description: One-line description of this project and its durable knowledge.', `description: ${JSON.stringify(description)}`);
      if (updated !== content) await fs.writeFile(file, updated, 'utf8');
    }
    index = `${index.replace(/\s*$/, '')}\n\n${link}\n`;
    await fs.writeFile(rootIndex, index, 'utf8');
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  return { id, path: id, location: `/workspace/${encodeURIComponent(id)}`, title, description, structure: 'OKF 0.2 project template' };
}

async function explicitProjectContext(message, primaryProject) {
  const references = [...String(message).matchAll(/@([A-Za-z][A-Za-z0-9_-]*)(?:\/([^\s,;:()\]\[}]+))?/g)].slice(0, 4);
  const attached = [];
  for (const match of references) {
    try {
      const project = match[1];
      // The bundle root is never a cross-project grant. A primary-project
      // mention is ordinary text: its files are already available to tools.
      if (project === 'workspace' || project === primaryProject) continue;
      const unresolvedRoot = projectRootForId(project);
      if (!(await isDirectory(unresolvedRoot))) continue;
      const root = await fs.realpath(unresolvedRoot);
      const requested = match[2] ? decodeURIComponent(match[2]) : 'index.md';
      if (requested.includes('\0') || path.isAbsolute(requested) || requested.split(/[\\/]/).includes('..')) continue;
      const candidate = path.resolve(root, requested); const target = await fs.realpath(candidate);
      if (!target.startsWith(`${root}${path.sep}`) || target.includes(`${path.sep}.git${path.sep}`) || path.basename(target).startsWith('.env')) continue;
      const stat = await fs.stat(target); if (!stat.isFile() || stat.size > 64 * 1024) continue;
      const content = await fs.readFile(target, 'utf8'); if (content.includes('\0')) continue;
      attached.push({ project, path: path.relative(root, target), content });
    } catch { /* unresolved references are ordinary user text, not a grant */ }
  }
  return attached;
}

function threadFile(id) {
  if (!/^[a-zA-Z0-9_-]{12,128}$/.test(id)) throw new Error('Invalid chat thread');
  return path.join(CHAT_STATE_DIR, `${id}.json`);
}
async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}
async function loadThread(id) {
  try { return JSON.parse(await fs.readFile(threadFile(id), 'utf8')); } catch (error) { if (error.code === 'ENOENT') throw new Error('Chat thread not found'); throw error; }
}
async function saveThread(thread) { thread.updatedAt = new Date().toISOString(); await writeAtomic(threadFile(thread.id), thread); }
async function withThreadWrite(id, work) {
  const previous = THREAD_WRITES.get(id) || Promise.resolve(); let release;
  const finished = new Promise(resolve => { release = resolve; }); const tail = previous.then(() => finished);
  THREAD_WRITES.set(id, tail); await previous;
  try { return await work(); }
  finally { release(); if (THREAD_WRITES.get(id) === tail) THREAD_WRITES.delete(id); }
}
async function listThreads(project) {
  const startedAt = Date.now();
  try {
    const files = await fs.readdir(CHAT_STATE_DIR); const result = [];
    for (const file of files) if (file.endsWith('.json')) {
      try { const thread = JSON.parse(await fs.readFile(path.join(CHAT_STATE_DIR, file), 'utf8')); if (thread.project === project) result.push(thread); } catch { /* skip corrupt local record */ }
    }
    const threads = result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(({ messages, ...summary }) => summary);
    log(`[ok-workbench] chat: loaded ${threads.length} thread${threads.length === 1 ? '' : 's'} for ${project} from ${files.filter(file => file.endsWith('.json')).length} saved thread file${files.filter(file => file.endsWith('.json')).length === 1 ? '' : 's'} in ${Date.now() - startedAt}ms`);
    return threads;
  } catch (error) { if (error.code === 'ENOENT') { log(`[ok-workbench] chat: no saved thread directory for ${project} (${Date.now() - startedAt}ms)`); return []; } throw error; }
}

async function providerCatalog() {
  const { configuredPiProviders } = await import('./pi-harness.mjs');
  const configured = await configuredPiProviders({ stateDir: CHAT_STATE_DIR });
  // The compatibility adapter is not a Pi provider, so retain its explicit
  // environment-based configuration alongside Pi's discovered catalog.
  if (process.env.LLM_COMPATIBLE_API_KEY && process.env.LLM_COMPATIBLE_BASE_URL) configured.push({ id: 'compatible', label: process.env.LLM_COMPATIBLE_LABEL || 'Compatible API', models: process.env.LLM_COMPATIBLE_MODEL ? [{ id: process.env.LLM_COMPATIBLE_MODEL, label: process.env.LLM_COMPATIBLE_MODEL }] : [] });
  return configured;
}
async function chatStatus(provider) {
  const startedAt = Date.now();
  const providers = await providerCatalog(); const selected = providers.find(item => item.id === provider) || providers[0];
  log(`[ok-workbench] chat: discovered ${providers.length} provider${providers.length === 1 ? '' : 's'} in ${Date.now() - startedAt}ms`);
  return {
    enabled: providers.some(item => item.models.length > 0),
    message: providers.length ? 'Choose an authenticated provider and model.' : 'Sign in with Pi or set a supported provider API key in this server process.',
    providers: providers.map(({ id, label, models }) => ({ id, label, models })),
    defaultProvider: selected?.id || '',
    models: selected?.models || [],
    defaultModel: selected?.models?.[0]?.id || ''
  };
}

async function startProviderLogin(provider) {
  if (!['openai-codex', 'github-copilot'].includes(provider)) throw new Error('This provider does not support browser sign-in');
  const label = provider === 'github-copilot' ? 'GitHub Copilot' : 'Codex';
  const existing = AUTH_FLOWS.get(provider);
  if (existing?.url) return { url: existing.url, user_code: existing.userCode || undefined, pending: true };
  if (existing) throw new Error(`${label} sign-in is starting; try again in a moment`);
  let resolveUrl; let rejectUrl;
  const url = new Promise((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject; });
  const flow = { url: '', userCode: '', respond: null, cancel: null };
  AUTH_FLOWS.set(provider, flow);
  try {
    const { startPiLogin } = await import('./pi-harness.mjs');
    const login = await startPiLogin({
      provider,
      stateDir: CHAT_STATE_DIR,
      onEvent: event => {
        if (event.type === 'auth_url') { flow.url = event.url; resolveUrl(event.url); }
        if (event.type === 'device_code') {
          const verificationUri = event.verificationUri || event.verification_uri;
          const userCode = event.userCode || event.user_code;
          if (typeof verificationUri !== 'string' || !verificationUri) throw new Error('GitHub Copilot sign-in did not provide a verification URL');
          flow.url = verificationUri; flow.userCode = typeof userCode === 'string' ? userCode : ''; resolveUrl(verificationUri);
        }
      },
      onPrompt: (prompt, respond) => {
        // Codex requires the browser option before it emits its auth URL.
        // Copilot asks for an optional Enterprise domain; blank selects
        // github.com and then emits a device code and verification URL.
        if (provider === 'openai-codex' && prompt.type === 'select') respond('browser');
        else if (provider === 'github-copilot' && prompt.type === 'text') respond('');
        else if (prompt.type === 'manual_code') flow.respond = respond;
      }
    });
    flow.cancel = login.cancel;
    void login.complete.then(() => {
      flow.completed = true;
      setTimeout(() => AUTH_FLOWS.delete(provider), 60_000).unref();
    }, error => {
      flow.error = error.message || `${label} sign-in failed`;
      rejectUrl(error);
      setTimeout(() => AUTH_FLOWS.delete(provider), 60_000).unref();
    });
    const address = await url;
    return { url: address, user_code: flow.userCode || undefined, pending: true };
  } catch (error) {
    AUTH_FLOWS.delete(provider);
    throw error;
  }
}

function turnWriter(res, threadId, turnId) {
  let sequence = 0;
  return (type, payload = {}) => res.write(`${JSON.stringify({ type, thread_id: threadId, turn_id: turnId, sequence: ++sequence, ...payload })}\n`);
}
async function providerStream({ provider, model, effort, messages, projectRoot, workspaceRoot = projectRoot, signal, onDelta, onTool, beforeCreateProject, systemPrompt, maxTokens, noWorkspaceTools = false }) {
  const configuration = (await providerCatalog()).find(item => item.id === provider);
  if (!configuration) throw new Error(`Provider ${provider || 'selection'} is not configured`);
  const selectedModel = model || configuration.models[0]?.id;
  if (!selectedModel) throw new Error(`Choose a model for ${configuration.label}`);
  // Pi owns all providers it discovers, including the subscription-only
  // openai-codex provider. The direct HTTP adapter below is only an opt-in
  // shortcut for Anthropic/OpenAI API keys; compatible is its own adapter.
  if (provider !== 'compatible' && !((process.env.OK_WORKBENCH_DIRECT_PROVIDER === '1' || process.env.OKF_WORKBENCH_DIRECT_PROVIDER === '1') && (provider === 'anthropic' || provider === 'openai'))) {
    const { runPiTurn } = await import('./pi-harness.mjs');
    return runPiTurn({ provider, model: selectedModel, effort, messages, projectRoot, workspaceRoot, stateDir: CHAT_STATE_DIR, signal, onDelta, onTool, beforeCreateProject, systemPrompt, noWorkspaceTools });
  }
  let endpoint; let headers; let body;
  if (provider === 'anthropic') {
    endpoint = 'https://api.anthropic.com/v1/messages';
    headers = { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
    body = { model: selectedModel, max_tokens: maxTokens || 4096, stream: true, system: systemPrompt || 'You are a project-scoped coding assistant. Use only supplied context and do not claim access to files you have not been given. When linking workspace files in a response, use workspace-relative Markdown paths such as [status](project/status.md).', messages: messages.map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content })) };
  } else {
    endpoint = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : `${process.env.LLM_COMPATIBLE_BASE_URL.replace(/\/$/, '')}/chat/completions`;
    const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.LLM_COMPATIBLE_API_KEY;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
    body = { model: selectedModel, max_tokens: maxTokens || 4096, stream: true, messages: [{ role: 'system', content: systemPrompt || 'You are a project-scoped coding assistant. Use only supplied context and do not claim access to files you have not been given. When linking workspace files in a response, use workspace-relative Markdown paths such as [status](project/status.md).' }, ...messages.map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content }))] };
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok || !response.body) throw new Error(`Provider request failed (${response.status})`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let eventName = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop();
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
      const named = block.split(/\r?\n/).find(line => line.startsWith('event:'));
      if (named) eventName = named.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const item = JSON.parse(data); const delta = provider === 'anthropic' ? (eventName === 'content_block_delta' ? item.delta?.text : '') : item.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch { /* ignore malformed provider event */ }
    }
  }
}

function cleanThreadTitle(value) {
  return String(value || '').replace(/^\s*(?:title\s*:\s*)?/i, '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 96);
}
async function generateThreadTitle({ provider, model, effort, projectRoot, prompt }) {
  let output = '';
  await providerStream({
    provider,
    model,
    effort,
    projectRoot,
    messages: [{ role: 'user', content: prompt }],
    onDelta: delta => { output += delta; },
    noWorkspaceTools: true,
    maxTokens: 48,
    systemPrompt: 'Write a clear, digestible one-line title for the user prompt. Use 3–10 words, preserve the user’s intent, and return only the title with no quotation marks, label, markdown, or final punctuation.'
  });
  return cleanThreadTitle(output);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    // Some Git subcommands close stdin before Node flushes the empty input
    // passed to `end()`. Handle that expected EPIPE on the stream so it cannot
    // become an unhandled process-level error; the child exit status remains
    // the authoritative command result.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('error', reject); child.on('close', code => (code === 0 || options.allowExitCodes?.includes(code)) ? resolve({ stdout, stderr, code }) : reject(Object.assign(new Error(stderr.trim() || `${command} failed`), { code, stdout, stderr })));
    child.stdin.end(options.input || '');
  });
}
async function gitProject(project) {
  const root = projectRootForId(project); if (!(await isDirectory(root))) throw new Error('Project not found');
  const repo = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim(); const canonicalRepo = await fs.realpath(repo); const canonicalProject = await fs.realpath(root);
  if (canonicalProject !== canonicalRepo && !canonicalProject.startsWith(`${canonicalRepo}${path.sep}`)) throw new Error('Project is not inside its Git worktree');
  return { root: canonicalProject, repo: canonicalRepo, pathspec: path.relative(canonicalRepo, canonicalProject) || '.' };
}
async function ensureWorkspaceGit(root) {
  let initialized = false;
  try { await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }); }
  catch { await run('git', ['init'], { cwd: root }); initialized = true; }
  const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  return { initialized, repository: stdout.trim() };
}
async function gitStatus(project) {
  const startedAt = Date.now(); const git = await gitProject(project); const { stdout } = await run('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', git.pathspec], { cwd: git.repo });
  const files = stdout.split('\n').filter(Boolean).map(line => ({ index: line.slice(0, 1), worktree: line.slice(1, 2), path: line.slice(3) }));
  log(`[ok-workbench] chat: checked Git status for ${project} (${files.length} changed file${files.length === 1 ? '' : 's'}) in ${Date.now() - startedAt}ms`);
  return { changedFiles: files.length, files };
}
async function gitDiff(project, source) {
  if (!['unstaged', 'staged', 'commits'].includes(source)) throw new Error('Invalid diff source');
  const git = await gitProject(project); let args; let commit = null;
  if (source === 'staged') args = ['diff', '--cached', '--no-ext-diff', '--no-color', '--find-renames', '--', git.pathspec];
  else if (source === 'commits') {
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: git.repo })).stdout.trim(); const parent = (await run('git', ['rev-parse', 'HEAD^'], { cwd: git.repo })).stdout.trim();
    const commitInfo = (await run('git', ['show', '-s', '--format=%h%x00%cI', 'HEAD'], { cwd: git.repo })).stdout.trim().split('\u0000'); commit = { hash: commitInfo[0], timestamp: commitInfo[1] };
    args = ['diff', '--no-ext-diff', '--no-color', '--find-renames', parent, head, '--', git.pathspec];
  } else args = ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--', git.pathspec];
  let { stdout: patch } = await run('git', args, { cwd: git.repo }); const status = await gitStatus(project);
  if (source !== 'staged' && source !== 'commits') for (const file of status.files.filter(file => file.index === '?' && file.worktree === '?')) {
    const candidate = path.resolve(git.repo, file.path); if (!candidate.startsWith(`${git.root}${path.sep}`)) continue;
    const relative = path.relative(git.repo, candidate); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const untracked = await run('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '/dev/null', relative], { cwd: git.repo, allowExitCodes: [1] }); patch += `${patch ? '\n' : ''}${untracked.stdout}`;
  }
  const token = patch && source !== 'commits' ? crypto.randomBytes(24).toString('base64url') : null;
  if (token) { DIFF_TOKENS.set(token, { project, source, patch, state: JSON.stringify(status), expiresAt: Date.now() + 5 * 60_000 }); setTimeout(() => DIFF_TOKENS.delete(token), 5 * 60_000).unref(); }
  return { source, patch, token, commit, summary: patch ? `${status.changedFiles} changed file${status.changedFiles === 1 ? '' : 's'} in current project` : 'No changes in this view.' };
}
async function applyGitAction(project, action, token) {
  const saved = DIFF_TOKENS.get(token); if (!saved || saved.project !== project || saved.expiresAt < Date.now()) throw new Error('The displayed diff has expired; refresh before changing files');
  const current = JSON.stringify(await gitStatus(project)); if (current !== saved.state) throw new Error('The Git state changed since this diff was displayed; refresh before changing files');
  const git = await gitProject(project); const args = action === 'unstage' ? ['apply', '--cached', '--reverse', '--check'] : ['apply', '--reverse', '--check'];
  await run('git', args, { cwd: git.repo, input: saved.patch });
  const applyArgs = action === 'unstage' ? ['apply', '--cached', '--reverse'] : ['apply', '--reverse']; await run('git', applyArgs, { cwd: git.repo, input: saved.patch }); DIFF_TOKENS.delete(token);
  const result = await gitStatus(project); const operationId = crypto.randomBytes(18).toString('base64url'); GIT_RECOVERY.set(operationId, { project, action, patch: saved.patch, state: JSON.stringify(result), expiresAt: Date.now() + 5 * 60_000 }); setTimeout(() => GIT_RECOVERY.delete(operationId), 5 * 60_000).unref();
  return { ...result, operationId };
}
async function undoGitAction(project, operationId) {
  const saved = GIT_RECOVERY.get(operationId); if (!saved || saved.project !== project || saved.expiresAt < Date.now()) throw new Error('The recovery patch has expired');
  const current = JSON.stringify(await gitStatus(project)); if (current !== saved.state) throw new Error('Git state changed since the revert; Undo is unsafe');
  const git = await gitProject(project); const args = saved.action === 'unstage' ? ['apply', '--cached', '--check'] : ['apply', '--check']; await run('git', args, { cwd: git.repo, input: saved.patch }); await run('git', args.slice(0, -1), { cwd: git.repo, input: saved.patch }); GIT_RECOVERY.delete(operationId);
  return gitStatus(project);
}
async function updateTodo(project, body) {
  const startLine = Number(body.startLine), endLine = Number(body.endLine);
  const original = typeof body.original === 'string' ? body.original : null;
  const replacement = typeof body.replacement === 'string' ? body.replacement : null;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || !original || replacement === null || replacement.length > 64 * 1024) throw new Error('Invalid task update');
  const root = await fs.realpath(projectRootForId(project)); const target = await bundlePath(safePath(String(body.path || '')));
  if (!target || (target !== root && !target.startsWith(`${root}${path.sep}`)) || path.basename(target).startsWith('.env') || target.includes(`${path.sep}.git${path.sep}`)) throw new Error('Task is outside the selected project');
  const content = await fs.readFile(target, 'utf8'); const lines = content.split('\n'); const actual = lines.slice(startLine - 1, endLine).join('\n');
  if (actual !== original) throw new Error('This task changed; reload the document before saving');
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacement.replace(/\r/g, '').split('\n'));
  await fs.writeFile(target, lines.join('\n'), 'utf8');
  return { path: path.relative(root, target).split(path.sep).join('/') };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/app.css') return respond(res, 200, await fs.readFile(path.join(__dirname, 'public/app.css')), 'text/css; charset=utf-8');
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') return respond(res, 200, await fs.readFile(path.join(__dirname, 'public/favicon.svg')), 'image/svg+xml');
    if (url.pathname === '/app.js') return respond(res, 200, await fs.readFile(path.join(__dirname, 'public/app.js')), 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/project') return respond(res, 200, JSON.stringify(await projectData(url.searchParams.get('path'))));
    if (url.pathname === '/api/document') return respond(res, 200, JSON.stringify(await documentData(url.searchParams.get('path') || '/workspace')));
    if (url.pathname === '/api/projects' && req.method === 'POST') { assertChatRequest(req); return json(res, 201, await createWorkspaceProject(await readJson(req))); }
    if (url.pathname === '/api/chat/session' && req.method === 'GET') { assertChatRequest(req); return json(res, 200, { csrf: CHAT_CSRF }); }
    if (url.pathname === '/api/chat/status' && req.method === 'GET') { assertChatRequest(req); return json(res, 200, await chatStatus(url.searchParams.get('provider'))); }
    const authMatch = url.pathname.match(/^\/api\/chat\/auth\/(openai-codex|github-copilot)\/start$/);
    if (authMatch && req.method === 'POST') { assertChatRequest(req); return json(res, 200, await startProviderLogin(authMatch[1])); }
    if (url.pathname === '/api/chat/threads' && req.method === 'GET') { assertChatRequest(req); return json(res, 200, await listThreads(url.searchParams.get('project'))); }
    if (url.pathname === '/api/chat/threads' && req.method === 'POST') {
      assertChatRequest(req); const body = await readJson(req); const root = projectRootForId(body.project); if (!(await isDirectory(root))) throw new Error('Project not found');
      const thread = { id: crypto.randomUUID().replace(/-/g, ''), project: body.project, provider: body.provider || '', model: body.model || '', effort: body.effort || '', titleProvider: body.titleProvider || body.provider || '', titleModel: body.titleModel || body.model || '', titleEffort: body.titleEffort || '', title: 'New conversation', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await saveThread(thread); const { messages, ...summary } = thread; return json(res, 201, summary);
    }
    const threadMatch = url.pathname.match(/^\/api\/chat\/threads\/([A-Za-z0-9_-]+)$/);
    if (threadMatch && req.method === 'GET') { assertChatRequest(req); return json(res, 200, await loadThread(threadMatch[1])); }
    if (threadMatch && req.method === 'DELETE') { assertChatRequest(req); await fs.unlink(threadFile(threadMatch[1])); return respond(res, 204, ''); }
    const cancelMatch = url.pathname.match(/^\/api\/chat\/threads\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)$/);
    if (cancelMatch && req.method === 'DELETE') {
      assertChatRequest(req);
      const active = ACTIVE_TURNS.get(cancelMatch[2]);
      if (!active || active.threadId !== cancelMatch[1]) throw new Error('Active turn not found');
      active.abort.abort();
      return respond(res, 204, '');
    }
    const turnMatch = url.pathname.match(/^\/api\/chat\/threads\/([A-Za-z0-9_-]+)\/turns$/);
    if (turnMatch && req.method === 'POST') {
      assertChatRequest(req); const body = await readJson(req); const message = String(body.message || '').trim(); if (!message) throw new Error('A chat message is required'); if (message.length > 50_000) throw new Error('Chat message is too long');
      const thread = await withThreadWrite(turnMatch[1], async () => {
        const current = await loadThread(turnMatch[1]); const provider = body.provider || current.provider; const model = body.model || current.model; const effort = body.effort || current.effort;
        const initiator = body.initiator === 'system' ? 'system' : 'user';
        current.provider = provider; current.model = model; current.effort = effort || ''; current.titleProvider = body.titleProvider || current.titleProvider || provider; current.titleModel = body.titleModel || current.titleModel || model; current.titleEffort = body.titleEffort || current.titleEffort || ''; current.messages.push({ id: crypto.randomUUID(), role: 'user', initiator, content: message, createdAt: new Date().toISOString() }); await saveThread(current); return current;
      }); const provider = thread.provider; const model = thread.model; const effort = thread.effort;
      const turnId = crypto.randomUUID().replace(/-/g, '');
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const writeEvent = turnWriter(res, thread.id, turnId); writeEvent('turn.started');
      let reply = ''; const abort = new AbortController(); ACTIVE_TURNS.set(turnId, { threadId: thread.id, abort }); req.on('aborted', () => abort.abort());
      try {
        const titlePromise = thread.messages.length === 1 ? generateThreadTitle({ provider: thread.titleProvider, model: thread.titleModel, effort: thread.titleEffort, projectRoot: projectRootForId(thread.project), prompt: message }).catch(() => '') : null;
        const grants = await explicitProjectContext(message, thread.project); const turnMessages = thread.messages.map(item => ({ ...item }));
        if (grants.length) { turnMessages[turnMessages.length - 1].content += `\n\n[Explicit cross-project context for this turn only]\n${grants.map(grant => `@${grant.project}/${grant.path}\n${grant.content}`).join('\n\n')}`; writeEvent('scope.granted', { grants: grants.map(grant => ({ project: grant.project, path: grant.path })) }); }
        await providerStream({ provider, model, effort, messages: turnMessages, projectRoot: projectRootForId(thread.project), workspaceRoot: BUNDLE_ROOT, beforeCreateProject: () => ensureWorkspaceGit(BUNDLE_ROOT), signal: abort.signal, onDelta: delta => { reply += delta; writeEvent('message.delta', { delta }); }, onTool: tool => {
          const diagnostic = { turnId, project: thread.project, phase: tool.phase, tool: tool.name };
          if (tool.error) diagnostic.error = tool.error;
          if (tool.result?.id) diagnostic.projectId = tool.result.id;
          if (tool.result?.location) diagnostic.location = tool.result.location;
          if (tool.result?.path) diagnostic.path = tool.result.path;
          if (tool.error) logError(`[ok-workbench] tool ${JSON.stringify(diagnostic)}`);
          const type = tool.phase === 'started' ? 'tool.started' : tool.phase === 'failed' ? 'tool.failed' : 'tool.completed';
          writeEvent(type, { tool: tool.name, result: tool.result, error: tool.error });
          if (tool.changed) writeEvent('workspace.changed', { project: thread.project, paths: tool.result?.paths || (tool.result?.path ? [tool.result.path] : []) });
        } });
        const title = titlePromise ? await titlePromise : '';
        await withThreadWrite(thread.id, async () => { const current = await loadThread(thread.id); if (title) current.title = title; current.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: reply, model, effort: effort || '', createdAt: new Date().toISOString() }); await saveThread(current); }); writeEvent('message.completed'); writeEvent('turn.completed');
      } catch (error) { writeEvent('turn.failed', { error: abort.signal.aborted || error.name === 'AbortError' ? 'Turn cancelled' : error.message }); }
      finally { ACTIVE_TURNS.delete(turnId); }
      return res.end();
    }
    const gitStatusMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/status$/);
    const todoMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/todos$/);
    if (todoMatch && req.method === 'POST') { assertChatRequest(req); return json(res, 200, await updateTodo(decodeURIComponent(todoMatch[1]), await readJson(req))); }
    if (gitStatusMatch && req.method === 'GET') { assertChatRequest(req); return json(res, 200, await gitStatus(decodeURIComponent(gitStatusMatch[1]))); }
    const gitDiffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/diff$/);
    if (gitDiffMatch && req.method === 'GET') { assertChatRequest(req); return json(res, 200, await gitDiff(decodeURIComponent(gitDiffMatch[1]), url.searchParams.get('source') || 'unstaged')); }
    const gitUndoMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/revert\/([A-Za-z0-9_-]+)\/undo$/);
    if (gitUndoMatch && req.method === 'POST') { assertChatRequest(req); return json(res, 200, await undoGitAction(decodeURIComponent(gitUndoMatch[1]), gitUndoMatch[2])); }
    const gitActionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/(revert|unstage)$/);
    if (gitActionMatch && req.method === 'POST') { assertChatRequest(req); const body = await readJson(req); return json(res, 200, await applyGitAction(decodeURIComponent(gitActionMatch[1]), gitActionMatch[2], body.token)); }
    if (url.pathname.startsWith('/agents')) {
      res.writeHead(308, { location: url.pathname.replace(/^\/agents/, '/workspace') }); return res.end();
    }
    if (url.pathname.startsWith('/asset/workspace/')) return asset(res, url.pathname.slice('/asset'.length));
    if (url.pathname === '/' || url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) return respond(res, 200, (await fs.readFile(path.join(__dirname, 'public/index.html'), 'utf8')).replace('__CHAT_CSRF__', CHAT_CSRF), 'text/html; charset=utf-8');
    return respond(res, 404, 'Not found', 'text/plain');
  } catch (error) { json(res, error.message === 'Not found' || error.message === 'Chat thread not found' ? 404 : 400, { error: error.message }); }
});

void resolveWorkspaceRoot().then(async root => {
  BUNDLE_ROOT = await fs.realpath(root);
  server.listen(PORT, '127.0.0.1', () => log(`OK Workbench: http://localhost:${PORT}/workspace/ (serving ${BUNDLE_ROOT})`));
}).catch(error => { logError(`OK Workbench could not open its workspace: ${error.message}`); process.exitCode = 1; });
