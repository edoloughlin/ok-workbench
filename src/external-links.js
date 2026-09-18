const crypto = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_GRANTS_PER_PROJECT = 32;
const MAX_FILES = 2_000;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ID = /^external-[A-Za-z0-9_-]{8,}$/;

function error(code, message, status = 400) { const value = new Error(message); value.code = code; value.status = status; return value; }
function within(root, target) { return target === root || target.startsWith(`${root}${path.sep}`); }
function isSensitiveName(name) { const lower = name.toLowerCase(); return lower.startsWith('.') || /^\.?(?:env|npmrc|netrc|pypirc)$/.test(lower) || /\.(?:pem|key|p12|pfx)$/i.test(lower) || /^(?:credentials|secrets)/i.test(name) || ['id_rsa', 'id_ed25519', 'known_hosts', '.git'].includes(lower); }
function isSkippedName(name) { return isSensitiveName(name) || name === 'node_modules' || name === '__pycache__'; }
function safeLinkPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) throw error('EXTERNAL_LINK_DENIED', 'An eligible project-relative symlink path is required', 403);
  const normalized = path.posix.normalize(value).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || normalized.split('/').some(isSensitiveName)) throw error('EXTERNAL_LINK_DENIED', 'The symlink path is not eligible for external access', 403);
  return normalized;
}
function recordBinding(record) { return JSON.stringify([record.workspaceRoot, record.projectRoot, record.linkPath, record.linkText, record.canonicalTarget, record.kind]); }
function statePath(stateDir) { return path.join(stateDir, 'external-links.json'); }
async function writeState(stateDir, value) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 }); await fs.chmod(stateDir, 0o700);
  const target = statePath(stateDir); const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await fs.rename(temporary, target);
}
async function loadState(stateDir) {
  let value;
  try { value = JSON.parse(await fs.readFile(statePath(stateDir), 'utf8')); }
  catch (cause) { if (cause.code === 'ENOENT') return { version: 1, grants: [] }; throw error('EXTERNAL_STATE_INVALID', 'External-link approval state cannot be read', 503); }
  if (!value || value.version !== 1 || !Array.isArray(value.grants)) throw error('EXTERNAL_STATE_INVALID', 'External-link approval state is invalid', 503);
  return value;
}
function validateRecord(record) {
  return record && typeof record === 'object' && ID.test(record.id) && typeof record.workspaceRoot === 'string' && typeof record.projectRoot === 'string' && typeof record.linkPath === 'string' && typeof record.linkText === 'string' && typeof record.canonicalTarget === 'string' && (record.kind === 'file' || record.kind === 'directory') && record.access === 'read' && typeof record.approvedAt === 'string';
}
async function inspectLink({ workspaceRoot, projectRoot, linkPath, deniedRoots = [] }) {
  const [workspace, project] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(projectRoot)]);
  if (!within(workspace, project) || project === workspace) throw error('EXTERNAL_LINK_DENIED', 'The selected project is not inside the workspace', 403);
  const relative = safeLinkPath(linkPath); const lexical = path.join(project, ...relative.split('/'));
  let cursor = project;
  for (const part of relative.split('/').slice(0, -1)) {
    cursor = path.join(cursor, part); const metadata = await fs.lstat(cursor).catch(cause => cause.code === 'ENOENT' ? null : Promise.reject(cause));
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw error('EXTERNAL_LINK_DENIED', 'Only a direct project symlink can receive external access', 403);
  }
  const metadata = await fs.lstat(lexical).catch(cause => cause.code === 'ENOENT' ? null : Promise.reject(cause));
  if (!metadata) throw error('EXTERNAL_LINK_MISSING', 'The symlink is missing', 404);
  if (!metadata.isSymbolicLink()) throw error('EXTERNAL_LINK_DENIED', 'External access requires a symbolic link', 403);
  const linkText = await fs.readlink(lexical); let canonicalTarget;
  try { canonicalTarget = await fs.realpath(lexical); } catch { throw error('EXTERNAL_LINK_MISSING', 'The symlink destination is missing', 404); }
  const target = await fs.lstat(canonicalTarget);
  if ((!target.isFile() && !target.isDirectory()) || target.isSymbolicLink() || (target.isFile() && target.nlink !== 1)) throw error('EXTERNAL_LINK_DENIED', 'The symlink target must be an eligible regular file or directory', 403);
  if (within(workspace, canonicalTarget) || [...deniedRoots, '/proc', '/sys', '/dev'].some(root => root && within(path.resolve(root), canonicalTarget))) throw error('EXTERNAL_LINK_DENIED', 'The symlink destination is not eligible for external access', 403);
  if (canonicalTarget.split(path.sep).filter(Boolean).some(isSensitiveName)) throw error('EXTERNAL_LINK_DENIED', 'The symlink destination contains a protected name', 403);
  return { workspaceRoot: workspace, projectRoot: project, linkPath: relative, linkText, canonicalTarget, kind: target.isDirectory() ? 'directory' : 'file', access: 'read' };
}
function sameBinding(record, inspection) { return recordBinding(record) === recordBinding(inspection); }
async function listGrants(stateDir, workspaceRoot, projectRoot, options = {}) {
  const state = await loadState(stateDir); const [workspace, project] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(projectRoot)]);
  const grants = state.grants.filter(validateRecord).filter(item => item.workspaceRoot === workspace && item.projectRoot === project);
  return Promise.all(grants.map(async grant => {
    try { const inspection = await inspectLink({ workspaceRoot: workspace, projectRoot: project, linkPath: grant.linkPath, deniedRoots: options.deniedRoots }); return { ...grant, status: sameBinding(grant, inspection) ? 'approved' : 'changed' }; }
    catch (cause) { return { ...grant, status: cause.code === 'EXTERNAL_LINK_MISSING' ? 'missing' : 'changed' }; }
  }));
}
async function approveGrant(stateDir, inspection) {
  const state = await loadState(stateDir); const count = state.grants.filter(item => validateRecord(item) && item.workspaceRoot === inspection.workspaceRoot && item.projectRoot === inspection.projectRoot && item.linkPath !== inspection.linkPath).length;
  if (count >= MAX_GRANTS_PER_PROJECT) throw error('EXTERNAL_LIMIT_EXCEEDED', `A project can approve at most ${MAX_GRANTS_PER_PROJECT} external links`, 413);
  const grant = { id: `external-${crypto.randomUUID().replaceAll('-', '')}`, ...inspection, approvedAt: new Date().toISOString() };
  state.grants = state.grants.filter(item => !(item?.workspaceRoot === grant.workspaceRoot && item?.projectRoot === grant.projectRoot && item?.linkPath === grant.linkPath)); state.grants.push(grant);
  await writeState(stateDir, state); return grant;
}
async function revokeGrant(stateDir, workspaceRoot, projectRoot, id) {
  if (!ID.test(id)) throw error('EXTERNAL_LINK_UNAPPROVED', 'Unknown external-link approval', 404);
  const state = await loadState(stateDir); const [workspace, project] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(projectRoot)]);
  state.grants = state.grants.filter(item => !(item?.id === id && item?.workspaceRoot === workspace && item?.projectRoot === project)); await writeState(stateDir, state);
}
async function activeGrants(stateDir, workspaceRoot, projectRoot, options = {}) {
  const state = await loadState(stateDir); const [workspace, project] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(projectRoot)]); const grants = [];
  for (const grant of state.grants) {
    if (!validateRecord(grant) || grant.workspaceRoot !== workspace || grant.projectRoot !== project) continue;
    let inspection; try { inspection = await inspectLink({ workspaceRoot: workspace, projectRoot: project, linkPath: grant.linkPath, deniedRoots: options.deniedRoots }); } catch (cause) { continue; }
    if (sameBinding(grant, inspection)) grants.push(grant);
  }
  return grants;
}
async function copyRegular(source, destination, budget) {
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW); try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES || budget.files >= MAX_FILES || budget.total + before.size > MAX_TOTAL_BYTES) throw error('EXTERNAL_LIMIT_EXCEEDED', 'External snapshot exceeds its file or total size limit', 413);
    const target = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400); try { await target.writeFile(await handle.readFile()); } finally { await target.close(); }
    const after = await handle.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw error('EXTERNAL_SNAPSHOT_CHANGED', 'External content changed while it was copied', 409);
    budget.total += before.size; budget.files++;
  } finally { await handle.close(); }
}
async function stageExternalGrants(grants) {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'ok-workbench-external-grants-')); await fs.chmod(directory, 0o700);
  const staged = {}; const budget = { total: 0, files: 0, entries: 0 };
  async function visit(source, destination, depth) {
    if (depth > MAX_DEPTH) throw error('EXTERNAL_LIMIT_EXCEEDED', 'External snapshot exceeds its directory depth limit', 413);
    await fs.mkdir(destination, { recursive: true, mode: 0o700 }); const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) { if (++budget.entries > MAX_ENTRIES) throw error('EXTERNAL_LIMIT_EXCEEDED', 'External snapshot exceeds its directory entry limit', 413); if (isSkippedName(entry.name)) continue; const from = path.join(source, entry.name); const to = path.join(destination, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) await visit(from, to, depth + 1); else if (entry.isFile()) await copyRegular(from, to, budget); }
  }
  try { for (const grant of grants) { const destination = path.join(directory, grant.id); if (grant.kind === 'file') await copyRegular(grant.canonicalTarget, destination, budget); else await visit(grant.canonicalTarget, destination, 0); staged[grant.linkPath] = { id: grant.id, kind: grant.kind, snapshotPath: destination, capturedAt: new Date().toISOString() }; } return { directory, staged }; }
  catch (cause) { await fs.rm(directory, { recursive: true, force: true }); throw cause; }
}

module.exports = { ID, activeGrants, approveGrant, error, inspectLink, isSensitiveName, listGrants, revokeGrant, safeLinkPath, stageExternalGrants, within };
