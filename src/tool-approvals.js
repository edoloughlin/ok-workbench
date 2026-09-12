const crypto = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const MAX_TOOL_MANIFEST = 16 * 1024;
const MAX_TOOL_TIMEOUT_SECONDS = 120;
const DEFAULT_TOOL_TIMEOUT_SECONDS = 30;
const PROVIDER_SECRET_PATTERN = /(?:openai|anthropic|gemini|mistral|openrouter|copilot|codex|llm[_-]?compatible)/i;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(value) { return JSON.stringify(value); }
function toolSecretEnvironmentName(name) { return `OK_WORKBENCH_TOOL_SECRET_${name.replaceAll('-', '_').toUpperCase()}`; }
function validSecretName(name) { return typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(name) && !PROVIDER_SECRET_PATTERN.test(name); }
function validHost(host) {
  return typeof host === 'string' && host.length <= 253 && host !== 'localhost' && net.isIP(host) === 0
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i.test(host);
}
function unique(values) { return [...new Set(values)]; }

function requirementsFromManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Tool manifest must be a JSON object');
  if (Object.keys(manifest).some(key => !['secrets', 'network', 'timeoutSeconds'].includes(key))) throw new Error('Tool manifest may contain only secrets, network, and timeoutSeconds requirements');
  const secrets = manifest.secrets === undefined ? [] : manifest.secrets;
  if (!Array.isArray(secrets) || secrets.length > 16 || secrets.some(name => !validSecretName(name))) throw new Error('Tool manifest secrets must be up to 16 logical, non-provider secret names');
  const network = manifest.network === undefined ? { hosts: [], ports: [] } : manifest.network;
  if (!network || typeof network !== 'object' || Array.isArray(network) || Object.keys(network).some(key => key !== 'hosts' && key !== 'ports')) throw new Error('Tool manifest network must describe hosts and optional ports');
  const hosts = network.hosts === undefined ? [] : network.hosts;
  const ports = network.ports === undefined ? [443] : network.ports;
  if (!Array.isArray(hosts) || hosts.length > 16 || hosts.some(host => !validHost(host))) throw new Error('Tool manifest network hosts must be public DNS names');
  if (!Array.isArray(ports) || ports.length > 16 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error('Tool manifest network ports must be valid TCP ports');
  if (hosts.length === 0 && (manifest.network !== undefined && ports.length)) throw new Error('Tool manifest network ports require at least one host');
  const timeoutSeconds = manifest.timeoutSeconds === undefined ? DEFAULT_TOOL_TIMEOUT_SECONDS : manifest.timeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TOOL_TIMEOUT_SECONDS) throw new Error(`Tool manifest timeoutSeconds must be an integer from 1 to ${MAX_TOOL_TIMEOUT_SECONDS}`);
  return { secrets: unique(secrets).sort(), network: { hosts: unique(hosts.map(host => host.toLowerCase())).sort(), ports: unique(ports).sort((a, b) => a - b) }, timeoutSeconds };
}

function toolPath(relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || !/^tools\/[^/.][^/]*$/.test(relative) || relative.endsWith('.tool.json')) throw new Error('Tools must be direct files in the selected project\'s tools/ directory');
  return relative;
}
function toolRuntime(firstLine) {
  const command = firstLine.trim().replace(/^#!\s*/, '');
  if (/^(?:\/usr\/bin\/env\s+)?python3(?:\s|$)/.test(command)) return 'python3';
  if (/^(?:\/usr\/bin\/env\s+)?(?:node|nodejs)(?:\s|$)/.test(command)) return 'nodejs';
  return null;
}
async function regularFile(file, error) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(error);
  return info;
}
async function inspectTool(projectRoot, relative) {
  const root = await fs.realpath(projectRoot); const tool = toolPath(relative); const target = path.resolve(root, tool);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Tool is outside the selected project');
  const info = await regularFile(target, 'Tool is not a regular file');
  if (!(info.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH))) throw new Error('Tool is not executable');
  if (info.size > 256 * 1024) throw new Error('Tool is too large');
  const source = await fs.readFile(target); const runtime = toolRuntime(source.toString('utf8').split(/\r?\n/, 1)[0]);
  if (!runtime) throw new Error('Tool must begin with a Python 3 or Node.js shebang');
  const extension = path.posix.extname(tool); const candidates = [...new Set([`${extension ? tool.slice(0, -extension.length) : tool}.tool.json`, `${tool}.tool.json`])];
  const manifests = [];
  for (const manifestPath of candidates) {
    const manifestTarget = path.resolve(root, manifestPath); const manifestInfo = await fs.lstat(manifestTarget).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (manifestInfo) manifests.push({ manifestPath, target: manifestTarget, info: manifestInfo });
  }
  if (manifests.length > 1) throw new Error('Tool has conflicting manifest files');
  if (!manifests.length) return { path: tool, runtime, manifestPath: null, toolSha256: sha256(source), manifestSha256: null, requirements: { secrets: [], network: { hosts: [], ports: [] }, timeoutSeconds: DEFAULT_TOOL_TIMEOUT_SECONDS } };
  const manifest = manifests[0];
  if (!manifest.info.isFile() || manifest.info.isSymbolicLink() || manifest.info.size > MAX_TOOL_MANIFEST) throw new Error('Tool manifest must be a regular JSON file under 16 KiB');
  const manifestSource = await fs.readFile(manifest.target);
  let value; try { value = JSON.parse(manifestSource); } catch { throw new Error('Tool manifest is not valid JSON'); }
  return { path: tool, runtime, manifestPath: manifest.manifestPath, toolSha256: sha256(source), manifestSha256: sha256(manifestSource), requirements: requirementsFromManifest(value) };
}

function approvalRecord(projectRoot, policy) {
  return {
    projectRoot,
    toolPath: policy.path,
    toolSha256: policy.toolSha256,
    manifestSha256: policy.manifestSha256,
    requirements: policy.requirements,
    filesystem: { selectedProject: 'read-write' },
  };
}
function sameApproval(left, right) { return stable(left) === stable(right); }
// Execution has selected-project read/write authority even when the manifest
// asks for no extra secret, network, or timeout capability. Treat it as an
// approval-worthy capability so importing a project cannot make arbitrary code
// runnable merely by omitting a manifest.
function approvalNeeded() { return true; }
function stateFile(stateDir, name) { return path.join(stateDir, name); }
async function readState(stateDir, name, fallback) {
  try { return JSON.parse(await fs.readFile(stateFile(stateDir, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeState(stateDir, name, value) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 }); await fs.chmod(stateDir, 0o700);
  const target = stateFile(stateDir, name); const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await fs.rename(temporary, target);
}
async function loadApprovals(stateDir) {
  const value = await readState(stateDir, 'tool-approvals.json', { approvals: [] });
  return Array.isArray(value?.approvals) ? value.approvals : [];
}
async function approveTool(stateDir, projectRoot, policy) {
  const root = await fs.realpath(projectRoot); const record = approvalRecord(root, policy); const approvals = await loadApprovals(stateDir);
  const retained = approvals.filter(item => !(item?.projectRoot === root && item?.toolPath === policy.path));
  const approved = { ...record, approvedAt: new Date().toISOString() }; retained.push(approved);
  await writeState(stateDir, 'tool-approvals.json', { approvals: retained }); return approved;
}
async function revokeToolApproval(stateDir, projectRoot, toolPathValue) {
  const root = await fs.realpath(projectRoot); const tool = toolPath(toolPathValue); const approvals = await loadApprovals(stateDir); const retained = approvals.filter(item => !(item?.projectRoot === root && item?.toolPath === tool));
  await writeState(stateDir, 'tool-approvals.json', { approvals: retained });
}
async function toolApprovalStatus(stateDir, projectRoot, policy) {
  const root = await fs.realpath(projectRoot); const record = approvalRecord(root, policy); const approvals = await loadApprovals(stateDir);
  return { required: approvalNeeded(policy.requirements), approved: !approvalNeeded(policy.requirements) || approvals.some(item => sameApproval({ projectRoot: item?.projectRoot, toolPath: item?.toolPath, toolSha256: item?.toolSha256, manifestSha256: item?.manifestSha256, requirements: item?.requirements, filesystem: item?.filesystem }, record)) };
}
async function loadToolSecrets(stateDir) {
  const value = await readState(stateDir, 'tool-secrets.json', { secrets: {} });
  return value && typeof value.secrets === 'object' && !Array.isArray(value.secrets) ? value.secrets : {};
}
async function setToolSecret(stateDir, name, value) {
  if (!validSecretName(name) || typeof value !== 'string' || !value || value.length > 16_384) throw new Error('Invalid logical tool secret');
  const secrets = await loadToolSecrets(stateDir); secrets[name] = value; await writeState(stateDir, 'tool-secrets.json', { secrets });
}
async function removeToolSecret(stateDir, name) {
  if (!validSecretName(name)) throw new Error('Invalid logical tool secret');
  const secrets = await loadToolSecrets(stateDir); delete secrets[name]; await writeState(stateDir, 'tool-secrets.json', { secrets });
}
async function resolveToolApproval(stateDir, projectRoot, policy) {
  const status = await toolApprovalStatus(stateDir, projectRoot, policy);
  if (!status.approved) throw new Error('Tool version requires explicit user approval before it can receive requested capabilities');
  const secrets = await loadToolSecrets(stateDir); const environment = {};
  for (const name of policy.requirements.secrets) {
    if (typeof secrets[name] !== 'string') throw new Error(`Tool requires an unset approved secret: ${name}`);
    environment[toolSecretEnvironmentName(name)] = secrets[name];
  }
  // Host-scoped egress needs a broker or firewall boundary. Until one exists,
  // approvals may record the requirement but execution remains fail-closed.
  if (policy.requirements.network.hosts.length) throw new Error('Approved host-scoped tool networking is not available in this build; network remains denied');
  return { environment, executionPolicy: { path: policy.path, toolSha256: policy.toolSha256, manifestSha256: policy.manifestSha256, requirements: policy.requirements, timeoutSeconds: policy.requirements.timeoutSeconds, resourceLimits: { memoryBytes: 512 * 1024 * 1024, cpuSeconds: Math.min(policy.requirements.timeoutSeconds, 60), processCount: 32, openFiles: 128, fileSizeBytes: 32 * 1024 * 1024 } } };
}

module.exports = { approveTool, inspectTool, loadApprovals, loadToolSecrets, removeToolSecret, requirementsFromManifest, resolveToolApproval, revokeToolApproval, setToolSecret, toolApprovalStatus, toolPath, validSecretName };
