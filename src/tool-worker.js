#!/usr/bin/env node

// Deliberately small JSONL file-tool server. The supervisor runs this process
// inside Bubblewrap with the selected project mounted at /workspace. Do not add
// shell execution here: future command execution needs a separate approval and
// resource-control policy.
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { constants } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');

let ROOT = path.resolve(process.env.OK_WORKSPACE_ROOT || process.env.OKF_WORKSPACE_ROOT || '/workspace');
let WORKSPACE_MODE = process.env.OK_WORKBENCH_WORKSPACE_MODE === '1';
let READ_GRANTS = parseReadGrants(process.env.OK_WORKBENCH_READ_GRANTS);
const MAX_READ = 256 * 1024;
const MAX_DOCUMENT_READ = 25 * 1024 * 1024;
const MAX_DOCUMENT_TEXT = 256 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_RESULTS = 200;
const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_TOOL_ARGUMENTS = 32;
const MAX_TOOL_ARGUMENT_LENGTH = 4 * 1024;
const DEFAULT_TOOL_TIMEOUT_SECONDS = 30;
const MAX_TOOL_MANIFEST = 16 * 1024;
const CONTENT_HASH_LENGTH = 12;
const ALWAYS_DENIED = new Set(['.git']);

function parseReadGrants(value) {
  if (!value) return new Map();
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter(([id, target]) => /^grant-[A-Za-z0-9_-]{8,}$/.test(id) && typeof target === 'string' && path.isAbsolute(target)));
  } catch { return new Map(); }
}
function isSensitiveName(name) {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || /^\.?(?:env|npmrc|netrc|pypirc)$/.test(lower) || /\.(?:pem|key|p12|pfx)$/i.test(lower) || /^(?:credentials|secrets)/i.test(name) || ['id_rsa', 'id_ed25519', 'known_hosts'].includes(lower);
}
function isDeniedPath(parts) { return parts.some(part => ALWAYS_DENIED.has(part) || isSensitiveName(part)); }

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('A relative path is required');
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw new Error('Path is outside the selected project');
  if (isDeniedPath(normalized.split('/'))) throw new Error('Path is not available to the agent');
  return normalized;
}
function isWithin(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }
function deniedCanonicalPath(root, target) {
  const relative = path.relative(root, target);
  return !relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => !part || isDeniedPath([part]));
}
async function targetFor(relative, write = false) {
  const safe = safeRelative(relative); const target = path.resolve(ROOT, safe);
  if (!target.startsWith(`${ROOT}${path.sep}`)) throw new Error('Path is outside the workspace');
  // macOS commonly presents temporary directories through /var even though
  // realpath returns /private/var. Compare canonical paths so that alias is
  // not mistaken for an escape, while still rejecting a real symlink escape.
  const root = await fs.realpath(ROOT);
  let ancestor = target; let real = null;
  while (!real) { real = await fs.realpath(ancestor).catch(() => null); if (!real) { const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error('Cannot resolve workspace path'); ancestor = parent; } }
  const canonical = path.resolve(real, path.relative(ancestor, target));
  if (!isWithin(root, canonical)) throw new Error('Symlink escapes workspace');
  // Check the final canonical location, not only user-controlled spelling.
  // This prevents aliases such as docs -> .git or public.md -> .npmrc from
  // bypassing the hidden-file policy.
  if (deniedCanonicalPath(root, canonical)) throw new Error('Path is not available to the agent');
  if (write) {
    const lexicalInfo = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (lexicalInfo?.isSymbolicLink()) throw new Error('Refusing to modify a symbolic link');
  }
  return { safe, target: canonical };
}
async function listFiles(relative = '.') {
  const start = relative === '.' ? { safe: '', target: ROOT } : await targetFor(relative); const output = [];
  async function visit(directory, prefix) {
    if (output.length >= MAX_RESULTS) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (isDeniedPath([entry.name])) continue;
      const child = path.join(directory, entry.name); const childRelative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) output.push(childRelative);
      if (output.length >= MAX_RESULTS) return;
    }
  }
  await visit(start.target, start.safe); return output;
}
function contentHash(content) { return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, CONTENT_HASH_LENGTH); }
async function readFile(relative) {
  const { safe, target } = await targetFor(relative); const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Path is not a file'); if (stat.size > MAX_READ) throw new Error('File is too large to read');
  const content = await fs.readFile(target, 'utf8'); if (content.includes('\0')) throw new Error('Binary files are not available'); return { path: safe, content, hash: contentHash(content) };
}
async function readGrantedFile(grantId) {
  if (typeof grantId !== 'string' || !/^grant-[A-Za-z0-9_-]{8,}$/.test(grantId)) throw new Error('Unknown read grant');
  const target = READ_GRANTS.get(grantId);
  if (!target) throw new Error('Unknown read grant');
  const info = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_READ) throw new Error('Granted file is unavailable');
  const content = await fs.readFile(target, 'utf8');
  if (content.includes('\0')) throw new Error('Granted file is binary');
  return { grantId, content, hash: contentHash(content) };
}
function cappedDocumentText(value) {
  const text = String(value || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { content: text.slice(0, MAX_DOCUMENT_TEXT), truncated: text.length > MAX_DOCUMENT_TEXT };
}
function decodeXml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]).replace(/&#(x[\da-f]+|\d+);/gi, (_match, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)));
}
function zipEntries(buffer) {
  let end = -1;
  for (let offset = Math.max(0, buffer.length - 65_557); offset <= buffer.length - 22; offset++) if (buffer.readUInt32LE(offset) === 0x06054b50) end = offset;
  if (end < 0) throw new Error('Office document is not a valid ZIP container');
  const entries = buffer.readUInt16LE(end + 10); const directoryOffset = buffer.readUInt32LE(end + 16); if (entries > MAX_ZIP_ENTRIES || directoryOffset >= buffer.length) throw new Error('Office document has an unsupported ZIP directory');
  const result = new Map(); let offset = directoryOffset; let total = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Office document has an invalid ZIP entry');
    const flags = buffer.readUInt16LE(offset + 8); const method = buffer.readUInt16LE(offset + 10); const compressed = buffer.readUInt32LE(offset + 20); const size = buffer.readUInt32LE(offset + 24); const nameLength = buffer.readUInt16LE(offset + 28); const extraLength = buffer.readUInt16LE(offset + 30); const commentLength = buffer.readUInt16LE(offset + 32); const localOffset = buffer.readUInt32LE(offset + 42); const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/') || name.includes('..') || name.startsWith('/')) continue;
    total += size; if (total > MAX_DOCUMENT_READ * 4) throw new Error('Office document expands beyond the extraction limit');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Office document has an invalid ZIP member');
    const localName = buffer.readUInt16LE(localOffset + 26); const localExtra = buffer.readUInt16LE(localOffset + 28); const start = localOffset + 30 + localName + localExtra; const source = buffer.subarray(start, start + compressed); if (source.length !== compressed) throw new Error('Office document is truncated');
    let content; if (method === 0) content = source; else if (method === 8) content = zlib.inflateRawSync(source, { maxOutputLength: MAX_DOCUMENT_READ * 4 }); else continue;
    if (content.length !== size || content.length > MAX_DOCUMENT_READ * 4) throw new Error('Office document has an invalid ZIP member size'); result.set(name, content.toString('utf8'));
  }
  return result;
}
function xmlParagraphs(xml, paragraphTag) {
  const paragraphs = []; const matcher = new RegExp(`<${paragraphTag}\\b[\\s\\S]*?<\\/${paragraphTag}>`, 'g');
  for (const paragraph of String(xml || '').match(matcher) || []) { const text = decodeXml(paragraph).replace(/\s+/g, ' ').trim(); if (text) paragraphs.push(text); }
  return paragraphs;
}
function extractDocx(entries) {
  const names = [...entries.keys()].filter(name => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name)).sort();
  return names.flatMap(name => xmlParagraphs(entries.get(name), 'w:p')).join('\n\n');
}
function extractPptx(entries) {
  const names = [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return names.map((name, index) => `Slide ${index + 1}\n${xmlParagraphs(entries.get(name), 'a:p').join('\n')}`).join('\n\n');
}
function extractXlsx(entries) {
  const sharedStrings = xmlParagraphs(entries.get('xl/sharedStrings.xml'), 'si'); const names = [...entries.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return names.map((name, index) => {
    const rows = []; for (const row of String(entries.get(name) || '').match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const cells = []; for (const cell of row.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []) { const reference = cell.match(/\br="([^"]+)"/)?.[1] || ''; const type = cell.match(/\bt="([^"]+)"/)?.[1]; const value = decodeXml(cell.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] || cell.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || ''); const text = type === 's' ? sharedStrings[Number(value)] || '' : value; if (text) cells.push(`${reference}: ${text}`); }
      if (cells.length) rows.push(cells.join(' | '));
    }
    return `Sheet ${index + 1}\n${rows.join('\n')}`;
  }).join('\n\n');
}
function extractOdt(entries) {
  return xmlParagraphs(entries.get('content.xml'), 'text:(?:h|p)').join('\n\n');
}
function extractOdp(entries) {
  const pages = String(entries.get('content.xml') || '').match(/<draw:page\b[\s\S]*?<\/draw:page>/g) || [];
  return pages.map((page, index) => `Slide ${index + 1}\n${xmlParagraphs(page, 'text:(?:h|p)').join('\n')}`).join('\n\n');
}
function extractOds(entries) {
  const sheets = String(entries.get('content.xml') || '').match(/<table:table\b[\s\S]*?<\/table:table>/g) || [];
  return sheets.map((sheet, index) => {
    const name = sheet.match(/\btable:name="([^"]+)"/)?.[1] || `Sheet ${index + 1}`; const rows = [];
    for (const row of sheet.match(/<table:table-row\b[\s\S]*?<\/table:table-row>/g) || []) {
      const cells = []; for (const cell of row.match(/<table:table-cell\b[\s\S]*?<\/table:table-cell>|<table:table-cell\b[^>]*\/>/g) || []) { const text = decodeXml(cell).replace(/\s+/g, ' ').trim(); const repeated = Math.min(Number(cell.match(/\btable:number-columns-repeated="(\d+)"/)?.[1]) || 1, 100); if (text) for (let repeat = 0; repeat < repeated; repeat++) cells.push(text); }
      if (cells.length) rows.push(cells.join(' | '));
    }
    return `${name}\n${rows.join('\n')}`;
  }).join('\n\n');
}
function pdfLiteral(value) {
  let output = ''; for (let index = 0; index < value.length; index++) { const char = value[index]; if (char !== '\\') { output += char; continue; } const next = value[++index] || ''; if (/[0-7]/.test(next)) { const digits = `${next}${value[index + 1] || ''}${value[index + 2] || ''}`.match(/^[0-7]{1,3}/)[0]; output += String.fromCharCode(parseInt(digits, 8)); index += digits.length - 1; } else output += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[next] || next; }
  return output;
}
function pdfHex(value) {
  const source = String(value || '').replace(/\s/g, ''); if (!/^(?:[\da-f]{2})+$/i.test(source)) return '';
  const bytes = Buffer.from(source, 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) { let output = ''; for (let index = 2; index + 1 < bytes.length; index += 2) output += String.fromCodePoint(bytes.readUInt16BE(index)); return output; }
  return bytes.toString('latin1');
}
function extractPdf(buffer) {
  const sources = [buffer.toString('latin1')]; const raw = buffer.toString('latin1'); const stream = /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of raw.matchAll(stream)) if (/\/FlateDecode/.test(match[1])) try { sources.push(zlib.inflateSync(Buffer.from(match[2], 'latin1')).toString('latin1')); } catch { /* Some PDF streams are not text streams. */ }
  const strings = []; for (const source of sources) { for (const match of source.matchAll(/\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")/g)) strings.push(pdfLiteral(match[0].replace(/\)\s*(?:Tj|'|")[\s\S]*$/, '').slice(1))); for (const match of source.matchAll(/<([\da-f\s]+)>\s*Tj/gi)) strings.push(pdfHex(match[1])); for (const match of source.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) for (const part of match[1].matchAll(/\((?:\\.|[^\\()])*\)|<([\da-f\s]+)>/g)) strings.push(part[1] === undefined ? pdfLiteral(part[0].slice(1, -1)) : pdfHex(part[1])); }
  return strings.join(' ').replace(/\s+/g, ' ').trim();
}
async function extractDocument(relative) {
  const { safe, target } = await targetFor(relative); const info = await fs.stat(target); if (!info.isFile()) throw new Error('Path is not a file'); if (info.size > MAX_DOCUMENT_READ) throw new Error('Document is too large to extract');
  const extension = path.extname(safe).toLowerCase(); if (!['.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'].includes(extension)) throw new Error('Supported document types are PDF, DOCX, PPTX, XLSX, ODT, ODP, and ODS'); const buffer = await fs.readFile(target);
  const content = extension === '.pdf' ? extractPdf(buffer) : (() => { const entries = zipEntries(buffer); if (extension === '.docx') return extractDocx(entries); if (extension === '.pptx') return extractPptx(entries); if (extension === '.xlsx') return extractXlsx(entries); if (extension === '.odt') return extractOdt(entries); if (extension === '.odp') return extractOdp(entries); return extractOds(entries); })(); const result = cappedDocumentText(content); if (!result.content) throw new Error('No extractable text was found in this document'); return { path: safe, format: extension.slice(1), ...result };
}
async function searchFiles(query, relative = '.') {
  if (typeof query !== 'string' || !query.trim() || query.length > 256) throw new Error('A short search query is required');
  const matches = [];
  for (const file of await listFiles(relative)) {
    if (matches.length >= MAX_RESULTS) break;
    try { const { content } = await readFile(file); const lines = content.split(/\r?\n/); lines.forEach((line, index) => { if (matches.length < MAX_RESULTS && line.toLowerCase().includes(query.toLowerCase())) matches.push({ path: file, line: index + 1, text: line.slice(0, 500) }); }); } catch { /* skip binary/large/unreadable files */ }
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
  const allowed = parts.length === 2 && parts[0] === 'tools';
  if (!allowed || !parts.at(-1) || parts.at(-1).startsWith('.')) throw new Error('Tools must be direct files in the selected project\'s tools/ directory');
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
  return parts.length === 2 && parts[0] === 'tools';
}
function toolTimeoutSeconds(value) {
  if (value === undefined) return DEFAULT_TOOL_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > 120) throw new Error('Tool manifest timeoutSeconds must be an integer from 1 to 120');
  return value;
}
function toolSecretNames(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16 || value.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || /(?:openai|anthropic|gemini|mistral|openrouter|copilot|codex|llm[_-]?compatible)/i.test(name))) throw new Error('Tool manifest secrets must be logical, non-provider secret names');
  return [...new Set(value)].sort();
}
function toolNetwork(value) {
  if (value === undefined) return { hosts: [], ports: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'hosts' && key !== 'ports')) throw new Error('Tool manifest network must describe hosts and optional ports');
  const hosts = value.hosts === undefined ? [] : value.hosts; const ports = value.ports === undefined ? [443] : value.ports;
  if (!Array.isArray(hosts) || hosts.length > 16 || hosts.some(host => typeof host !== 'string' || host === 'localhost' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(host))) throw new Error('Tool manifest network hosts must be public DNS names');
  if (!Array.isArray(ports) || ports.length > 16 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error('Tool manifest network ports must be valid TCP ports');
  if (!hosts.length && ports.length) throw new Error('Tool manifest network ports require at least one host');
  return { hosts: [...new Set(hosts.map(host => host.toLowerCase()))].sort(), ports: [...new Set(ports)].sort((a, b) => a - b) };
}
function toolRequirements(manifest) { return { secrets: toolSecretNames(manifest.secrets), network: toolNetwork(manifest.network), timeoutSeconds: toolTimeoutSeconds(manifest.timeoutSeconds) }; }
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
  const toolSource = await fs.readFile(tool.target);
  const toolSha256 = crypto.createHash('sha256').update(toolSource).digest('hex');
  if (!info) return { path: tool.path, runtime: tool.runtime, manifestPath: null, toolSha256, manifestSha256: null, requirements: { secrets: [], network: { hosts: [], ports: [] }, timeoutSeconds: DEFAULT_TOOL_TIMEOUT_SECONDS } };
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TOOL_MANIFEST) throw new Error('Tool manifest must be a regular JSON file under 16 KiB');
  const manifestSource = await fs.readFile(target);
  let manifest;
  try { manifest = JSON.parse(manifestSource); } catch { throw new Error('Tool manifest is not valid JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => key !== 'secrets' && key !== 'network' && key !== 'timeoutSeconds')) throw new Error('Tool manifest may contain only secrets, network, and timeoutSeconds requirements');
  return { path: tool.path, runtime: tool.runtime, manifestPath: manifests[0].manifestPath, toolSha256, manifestSha256: crypto.createHash('sha256').update(manifestSource).digest('hex'), requirements: toolRequirements(manifest) };
}
async function listWorkspaceTools() {
  const directories = ['tools'];
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
  const [tool, policy] = await Promise.all([workspaceTool(relative), workspaceToolPolicy(relative)]); const args = toolArguments(argumentsList);
  if (process.platform !== 'linux') throw new Error('Workspace tools require Linux resource controls in this build');
  let approved;
  try { approved = JSON.parse(process.env.OK_WORKBENCH_TOOL_EXECUTION_POLICY || ''); } catch { throw new Error('Workspace tool execution was not authorized by Workbench'); }
  if (!approved || approved.path !== tool.path || approved.toolSha256 !== policy.toolSha256 || approved.manifestSha256 !== policy.manifestSha256 || JSON.stringify(approved.requirements) !== JSON.stringify(policy.requirements) || !Number.isInteger(approved.timeoutSeconds) || !approved.resourceLimits) throw new Error('Tool changed after approval or was not authorized by Workbench');
  const command = tool.runtime === 'python3' ? 'python3' : process.execPath;
  const limits = approved.resourceLimits;
  if (![limits.memoryBytes, limits.cpuSeconds, limits.processCount, limits.openFiles, limits.fileSizeBytes].every(value => Number.isInteger(value) && value > 0)) throw new Error('Invalid Workbench resource policy');
  return new Promise((resolve, reject) => {
    const prlimit = '/usr/bin/prlimit';
    const child = spawn(prlimit, [`--as=${limits.memoryBytes}`, `--cpu=${limits.cpuSeconds}`, `--nproc=${limits.processCount}`, `--nofile=${limits.openFiles}`, `--fsize=${limits.fileSizeBytes}`, '--', command, tool.target, ...args], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: true });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const capture = (current, chunk) => `${current}${chunk}`.slice(0, MAX_TOOL_OUTPUT);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });
    const killTree = signal => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    const timeout = setTimeout(() => { timedOut = true; killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 1_000).unref(); }, approved.timeoutSeconds * 1000);
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return; settled = true;
      clearTimeout(timeout);
      if (timedOut) return reject(new Error(`Tool timed out after ${approved.timeoutSeconds} seconds`));
      resolve({ path: tool.path, runtime: tool.runtime, arguments: args, exitCode: code, signal: signal || null, stdout, stderr, ok: code === 0 && !signal });
    };
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`Tool could not start: ${error.message}`)); } });
    // Do not wait for `close`: a malicious descendant can inherit stdout or
    // stderr, detach into a different process group, and keep those pipes open.
    // The supervisor immediately tears down the enclosing PID namespace after
    // this result, which kills such descendants as well.
    child.once('exit', finish);
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
function managedPath(relative) { return isToolFile(relative) || safeRelative(relative).endsWith('.tool.json'); }
async function moveFile({ from, to }) {
  if (managedPath(from) || managedPath(to)) throw new Error('Workspace tools and their manifests are managed outside agent file updates');
  const [source, destination] = await Promise.all([targetFor(from), targetFor(to, true)]);
  if (source.safe === destination.safe) throw new Error('Source and destination paths must differ');
  const sourceInfo = await fs.lstat(source.target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Source must be a regular file');
  const destinationInfo = await fs.lstat(destination.target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (destinationInfo) throw new Error('Destination already exists');
  if (!(await directoryExists(path.dirname(destination.target)))) throw new Error('Destination directory does not exist');
  await fs.rename(source.target, destination.target);
  return { from: source.safe, to: destination.safe };
}
function linesForEdit(content) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'; const finalNewline = content.endsWith(newline);
  const body = finalNewline ? content.slice(0, -newline.length) : content;
  return { lines: body ? body.split(newline) : [], newline, finalNewline };
}
function replacementLines(content) { return content === '' ? [] : content.replace(/\r\n?/g, '\n').split('\n'); }
async function editFile({ path: relative, hash, edits }) {
  if (managedPath(relative)) throw new Error('Workspace tools and their manifests are managed outside agent file updates');
  if (typeof hash !== 'string' || !new RegExp(`^[a-f0-9]{${CONTENT_HASH_LENGTH}}$`).test(hash)) throw new Error(`Provide the ${CONTENT_HASH_LENGTH}-character content hash returned by read_file`);
  if (!Array.isArray(edits) || !edits.length || edits.length > 64) throw new Error('Provide 1–64 line-range edits');
  const { safe, target } = await targetFor(relative, true); const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Path is not a regular file'); if (info.size > MAX_READ) throw new Error('File is too large to edit');
  const original = await fs.readFile(target, 'utf8'); if (original.includes('\0')) throw new Error('Binary files are not available');
  if (contentHash(original) !== hash) throw new Error('File content changed since it was read; re-read the file and use its current hash');
  const { lines, newline, finalNewline } = linesForEdit(original); const prepared = edits.map(edit => {
    if (!edit || !Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine) || edit.startLine < 1 || edit.endLine < edit.startLine || edit.endLine > lines.length || typeof edit.replacement !== 'string' || edit.replacement.length > 1024 * 1024) throw new Error('Each edit needs valid startLine, endLine, and replacement text');
    return { startLine: edit.startLine, endLine: edit.endLine, replacement: replacementLines(edit.replacement) };
  }).sort((left, right) => left.startLine - right.startLine);
  for (let index = 1; index < prepared.length; index++) if (prepared[index - 1].endLine >= prepared[index].startLine) throw new Error('Line-range edits must not overlap');
  for (const edit of [...prepared].reverse()) lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.replacement);
  const content = `${lines.join(newline)}${finalNewline ? newline : ''}`; await fs.writeFile(target, content, 'utf8');
  return { path: safe, hash: contentHash(content), bytes: Buffer.byteLength(content), edits: prepared.length };
}
async function directoryExists(target) { return fs.stat(target).then(value => value.isDirectory()).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)); }
function normalizeMarkdown(value) { return String(value).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd(); }
async function existingContent(relative) {
  const { target } = await targetFor(relative);
  return fs.readFile(target, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
}
function appendProjectLog(content, summary) {
  const date = new Date().toISOString().slice(0, 10);
  return `${String(content || '').trimEnd()}\n\n## ${date}\n\n- ${summary.trim()}\n`;
}
async function applyWorkspaceProjectUpdate({ kind, summary, changes }) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 64) throw new Error('Provide 1–64 workspace file changes');
  if (!['correction', 'substantive'].includes(kind)) throw new Error('Project update kind must be correction or substantive');
  if (kind === 'substantive' && (typeof summary !== 'string' || !summary.trim())) throw new Error('Substantive project updates need a summary');
  const prepared = new Map();
  for (const change of changes) {
    if (!change || typeof change.content !== 'string' || change.content.length > 1024 * 1024) throw new Error('Each workspace change needs text content under 1 MiB');
    const { safe } = await targetFor(change.path, true);
    if (prepared.has(safe)) throw new Error(`Duplicate workspace change: ${safe}`);
    prepared.set(safe, change.content);
  }
  const original = new Map(await Promise.all([...prepared.keys()].map(async safe => [safe, await existingContent(safe)])));
  const changed = new Set([...prepared].filter(([safe, content]) => original.get(safe) === null || normalizeMarkdown(original.get(safe)) !== normalizeMarkdown(content)).map(([safe]) => safe));
  const projects = new Set(); const newDirectories = new Set();
  for (const safe of prepared.keys()) {
    const parts = safe.split('/'); if (parts.length < 2) continue;
    const project = parts[0];
    if (prepared.has(`${project}/index.md`) || await fs.stat(path.join(ROOT, project, 'index.md')).then(item => item.isFile()).catch(() => false)) projects.add(project);
    for (let directory = parts.slice(0, -1).join('/'); directory; directory = directory.split('/').slice(0, -1).join('/')) {
      if (!(await directoryExists(path.join(ROOT, directory)))) { newDirectories.add(directory); if (!prepared.has(`${directory}/index.md`)) throw new Error(`New directory ${directory} requires ${directory}/index.md in the same update`); }
    }
  }
  for (const project of projects) {
    const meaningfulPaths = [...changed].filter(safe => safe.startsWith(`${project}/`) && safe !== `${project}/log.md`);
    if (!meaningfulPaths.length) continue;
    if (kind === 'correction' && meaningfulPaths.length > 3) throw new Error(`Correction updates may change at most 3 meaningful files in ${project}; use a substantive update instead`);
    if (kind !== 'substantive') continue;
    const structural = [...newDirectories].some(directory => directory === project || directory.startsWith(`${project}/`)) || meaningfulPaths.some(safe => original.get(safe) === null && path.posix.dirname(safe) === project);
    const missing = [];
    if (!changed.has(`${project}/status.md`)) missing.push(`${project}/status.md`);
    if (structural && !changed.has(`${project}/index.md`)) missing.push(`${project}/index.md`);
    if (missing.length) throw new Error(`Substantive project update requires meaningful changes to: ${missing.join(', ')}. The summary is recorded in ${project}/log.md automatically.`);
    prepared.set(`${project}/log.md`, appendProjectLog(prepared.get(`${project}/log.md`) ?? await existingContent(`${project}/log.md`), summary));
  }
  const written = [];
  for (const [safe, content] of prepared) written.push(await applyPatch({ path: safe, content }));
  return { paths: written.map(item => item.path), bytes: written.reduce((sum, item) => sum + item.bytes, 0) };
}
async function applyProjectUpdate({ kind, summary, changes }) {
  if (WORKSPACE_MODE) return applyWorkspaceProjectUpdate({ kind, summary, changes });
  if (!Array.isArray(changes) || !changes.length || changes.length > 64) throw new Error('Provide 1–64 selected-project file changes');
  if (!['correction', 'substantive'].includes(kind)) throw new Error('Project update kind must be correction or substantive');
  if (kind === 'substantive' && (typeof summary !== 'string' || !summary.trim())) throw new Error('Substantive project updates need a summary');
  const prepared = new Map();
  for (const change of changes) {
    if (!change || typeof change.content !== 'string' || change.content.length > 1024 * 1024) throw new Error('Each project change needs text content under 1 MiB');
    const { safe } = await targetFor(change.path, true);
    if (prepared.has(safe)) throw new Error(`Duplicate project change: ${safe}`);
    prepared.set(safe, change.content);
  }
  const original = new Map(await Promise.all([...prepared.keys()].map(async safe => [safe, await existingContent(safe)])));
  const changed = new Set([...prepared].filter(([safe, content]) => original.get(safe) === null || normalizeMarkdown(original.get(safe)) !== normalizeMarkdown(content)).map(([safe]) => safe));
  const newDirectories = new Set();
  for (const safe of prepared.keys()) for (let directory = path.posix.dirname(safe); directory && directory !== '.'; directory = path.posix.dirname(directory)) {
    if (!(await directoryExists(path.join(ROOT, directory)))) {
      newDirectories.add(directory);
      if (!prepared.has(`${directory}/index.md`)) throw new Error(`New directory ${directory} requires ${directory}/index.md in the same update`);
    }
  }
  if (kind === 'substantive') {
    const meaningful = [...changed].filter(safe => safe !== 'log.md');
    if (meaningful.length) {
      const missing = [];
      if (!changed.has('status.md')) missing.push('status.md');
      const structural = newDirectories.size > 0 || meaningful.some(safe => original.get(safe) === null && path.posix.dirname(safe) === '.');
      if (structural && !changed.has('index.md')) missing.push('index.md');
      if (missing.length) throw new Error(`Substantive project update requires meaningful changes to: ${missing.join(', ')}. The summary is recorded in log.md automatically.`);
      prepared.set('log.md', appendProjectLog(prepared.get('log.md') ?? await existingContent('log.md'), summary));
    }
  }
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
  if (!WORKSPACE_MODE) throw new Error('Creating a project requires deliberate workspace mode');
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

function setWorkspaceRoot(root, { workspaceMode = false, readGrants = {} } = {}) { ROOT = path.resolve(root); WORKSPACE_MODE = workspaceMode; READ_GRANTS = new Map(Object.entries(readGrants)); }
function startWorker() {
  const operations = { list_files: ({ path }) => listFiles(path || '.'), read_file: ({ path }) => readFile(path), read_granted_file: ({ grant_id: grantId }) => readGrantedFile(grantId), extract_document: ({ path }) => extractDocument(path), search_files: ({ query, path }) => searchFiles(query, path || '.'), move_file: moveFile, edit_file: editFile, list_workspace_tools: listWorkspaceTools, workspace_tool_policy: ({ path }) => workspaceToolPolicy(path), run_workspace_tool: runWorkspaceTool, apply_project_update: applyProjectUpdate, create_project: createProject };
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
module.exports = { setWorkspaceRoot, listFiles, readFile, readGrantedFile, extractDocument, searchFiles, moveFile, editFile, listWorkspaceTools, workspaceToolPolicy, runWorkspaceTool, applyPatch, applyProjectUpdate, createProject, startWorker };

if (require.main === module) startWorker();
