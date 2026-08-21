import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(APP_DIR, 'tool-worker.js');
const PROJECT_TEMPLATE = path.resolve(APP_DIR, '..', 'seed', 'workspace', 'templates', 'project');
const MACOS_SANDBOX_PROFILE = path.join(APP_DIR, 'macos-sandbox.sb');
const MACOS_NETWORK_SANDBOX_PROFILE = path.join(APP_DIR, 'macos-network-sandbox.sb');
const MAX_AGENT_INSTRUCTIONS = 64 * 1024;
const WORKER_READY_TIMEOUT = 5_000;

function logError(...args) { console.error(`[${new Date().toISOString()}]`, ...args); }

async function exists(file, mode = constants.F_OK) { try { await access(file, mode); return true; } catch { return false; } }
async function bwrapPath() {
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) if (await exists(candidate, constants.X_OK)) return candidate;
  return null;
}

export function sandboxBackend(platform = process.platform) {
  if (platform === 'linux') return 'bubblewrap';
  if (platform === 'darwin') return 'seatbelt';
  return null;
}

export function sandboxChildEnvironment({ workspace, template, temporaryDirectory, platform, toolEnvironment = {} }) {
  const sandboxRoot = platform === 'linux' ? '/workspace' : workspace;
  const sandboxTemplate = platform === 'linux' ? '/ok-workbench-template' : template;
  const temporary = platform === 'linux' ? '/tmp' : temporaryDirectory;
  const environment = {
    PATH: '/usr/bin:/bin', HOME: temporary, TMPDIR: temporary,
    OK_WORKSPACE_ROOT: sandboxRoot, OKF_WORKSPACE_ROOT: sandboxRoot,
    OK_WORKBENCH_PROJECT_TEMPLATE: sandboxTemplate,
  };
  // Avoid CoreFoundation falling back to ~/.CFUserTextEncoding. The worker has
  // no reason to read a user-home file just to determine a text encoding.
  if (platform === 'darwin') environment.__CF_USER_TEXT_ENCODING = `0x${process.getuid().toString(16)}:0:0`;
  return { ...environment, ...toolEnvironment };
}

function nodeRuntimeRoot(nodeBinary) {
  // Homebrew and nvm both put node in a versioned `bin/` directory.  Keep the
  // profile grant at that version directory instead of a broad prefix such as
  // /opt/homebrew or the user's home directory.
  return nodeBinary.startsWith('/usr/bin/') ? path.dirname(nodeBinary) : path.dirname(path.dirname(nodeBinary));
}

export function macosSandboxArgs({ workspace, template, temporaryDirectory, nodeBinary, workerSource, network = false }) {
  const runtime = nodeRuntimeRoot(nodeBinary);
  return [
    '-D', `WORKSPACE=${workspace}`, '-D', `TEMPLATE=${template}`,
    '-D', `PRIVATE_TMP=${temporaryDirectory}`, '-D', `NODE_BINARY=${nodeBinary}`,
    '-D', `NODE_RUNTIME=${runtime}`, '-f', network ? MACOS_NETWORK_SANDBOX_PROFILE : MACOS_SANDBOX_PROFILE,
    nodeBinary, '--input-type=commonjs', '--eval', workerSource,
  ];
}

async function workerConfiguration(projectRoot, platform) {
  const [workspace, template, nodeBinary] = await Promise.all([realpath(projectRoot), realpath(PROJECT_TEMPLATE), realpath(process.execPath)]);
  const [workspaceInfo, templateInfo] = await Promise.all([stat(workspace), stat(template)]);
  if (!workspaceInfo.isDirectory()) throw new Error('Workspace root is not a directory');
  if (!templateInfo.isDirectory()) throw new Error('Packaged OKF project template is unavailable');
  const workerSource = `${await readFile(WORKER, 'utf8')}\nstartWorker();`;
  const temporaryDirectory = platform === 'darwin' ? await mkdtemp(path.join(tmpdir(), 'ok-workbench-worker-')) : null;
  if (temporaryDirectory) {
    await chmod(temporaryDirectory, 0o700);
    return { workspace, template, nodeBinary, workerSource, temporaryDirectory: await realpath(temporaryDirectory) };
  }
  return { workspace, template, nodeBinary, workerSource, temporaryDirectory: null };
}

async function cleanupTemporaryDirectory(directory) {
  if (!directory) return;
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function sandboxCommand(platform) {
  if (platform === 'linux') return bwrapPath();
  if (platform === 'darwin' && await exists('/usr/bin/sandbox-exec', constants.X_OK)) return '/usr/bin/sandbox-exec';
  return null;
}

async function waitForSpawn(child) {
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
}

export class TurnWorker {
  constructor(child, { cleanup, onUnexpectedExit } = {}) {
    this.child = child; this.cleanup = cleanup; this.onUnexpectedExit = onUnexpectedExit; this.cleaned = false; this.closedByCaller = false; this.pending = new Map(); this.sequence = 0; this.buffer = ''; this.stderr = ''; this.failure = null; this.ready = false; this.readyWaiters = [];
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => this.read(chunk));
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', chunk => { this.stderr = `${this.stderr}${chunk}`.slice(-4096); });
    child.on('error', error => this.failAll(new Error(`Sandbox worker failed: ${error.message}`)));
    // `close` follows stderr draining, so the sandbox diagnostic reaches the
    // browser with the failure rather than being lost to an ignored stream.
    child.on('close', (code, signal) => {
      const error = this.exitError(code, signal);
      this.failAll(error);
      if (!this.closedByCaller && (code !== 0 || signal)) this.onUnexpectedExit?.({ pid: child.pid, code, signal, stderr: this.stderr.trim(), error: error.message });
      this.removeTemporaryDirectory();
    });
    child.stdin?.on('error', error => this.failAll(new Error(`Sandbox worker input failed: ${error.message}`)));
    // A failed sandbox setup can exit between spawn succeeding and this
    // listener being installed. Preserve that failure for later tool calls.
    if (child.exitCode !== null || child.signalCode !== null) this.failAll(this.exitError(child.exitCode, child.signalCode));
  }
  removeTemporaryDirectory() { if (!this.cleaned) { this.cleaned = true; void this.cleanup?.(); } }
  exitError(code, signal) { const status = signal ? `was killed by ${signal}` : `exited with status ${code ?? 'unknown'}`; const detail = this.stderr.trim(); return new Error(`Sandbox worker ${status}${detail ? `: ${detail}` : ''}`); }
  read(chunk) {
    this.buffer += chunk; const lines = this.buffer.split('\n'); this.buffer = lines.pop();
    for (const line of lines) try { const response = JSON.parse(line); if (response.ready === true) { this.ready = true; for (const waiter of this.readyWaiters.splice(0)) waiter.resolve(); continue; } const pending = this.pending.get(response.id); if (!pending) continue; this.pending.delete(response.id); response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error || 'Workspace operation failed')); } catch { /* malformed worker response is ignored */ }
  }
  failAll(error) { if (!this.failure) this.failure = error; for (const { reject } of this.pending.values()) reject(this.failure); this.pending.clear(); for (const waiter of this.readyWaiters.splice(0)) waiter.reject(this.failure); }
  waitForReady(timeout = WORKER_READY_TIMEOUT) {
    if (this.ready) return Promise.resolve(); if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.readyWaiters = this.readyWaiters.filter(waiter => waiter !== item); reject(new Error('Sandbox worker did not become ready')); }, timeout);
      const item = { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
      this.readyWaiters.push(item);
    });
  }
  call(operation, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.child.stdin?.writable) return this.failAll(new Error('Sandbox worker input is unavailable'));
      try { this.child.stdin.write(`${JSON.stringify({ id, operation, params })}\n`, error => { if (error) this.failAll(new Error(`Sandbox worker input failed: ${error.message}`)); }); } catch (error) { this.failAll(new Error(`Sandbox worker input failed: ${error.message}`)); }
    });
  }
  close() { this.closedByCaller = true; this.child.kill('SIGTERM'); this.failAll(new Error('Sandbox worker closed')); }
}

export async function createTurnWorker(projectRoot, { platform = process.platform, network = false, toolEnvironment = {} } = {}) {
  const backend = sandboxBackend(platform); const command = await sandboxCommand(platform);
  if (!backend || !command) return null;
  let configuration;
  try { configuration = await workerConfiguration(projectRoot, platform); }
  catch (error) { throw new Error(`Sandbox worker setup failed: ${error.message}`); }
  let args;
  if (backend === 'bubblewrap') {
    // The worker source is evaluated so the sandbox never mounts the package
    // installation or seed bundle. Its only user-data mount is /workspace.
    args = ['--unshare-all', ...(network ? ['--share-net'] : []), '--new-session', '--die-with-parent', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'OK_WORKSPACE_ROOT', '/workspace', '--setenv', 'OKF_WORKSPACE_ROOT', '/workspace', '--setenv', 'OK_WORKBENCH_PROJECT_TEMPLATE', '/ok-workbench-template', '--tmpfs', '/', '--dir', '/workspace', '--bind', configuration.workspace, '/workspace', '--ro-bind', configuration.template, '/ok-workbench-template', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', ...(network ? ['--dir', '/etc', '--dir', '/etc/ssl'] : []), '--chdir', '/workspace'];
    for (const systemPath of ['/usr', '/bin', '/lib', '/lib64']) if (await exists(systemPath)) args.push('--ro-bind', systemPath, systemPath);
    // Network clients such as ssh resolve the effective UID before opening a
    // connection. Preserve only the account databases they need, rather than
    // mounting /etc wholesale into a network-authorized tool sandbox.
    if (network) for (const [source, destination] of [['/etc/passwd', '/etc/passwd'], ['/etc/group', '/etc/group'], ['/etc/resolv.conf', '/etc/resolv.conf'], ['/etc/hosts', '/etc/hosts'], ['/etc/nsswitch.conf', '/etc/nsswitch.conf'], ['/etc/ssl/certs', '/etc/ssl/certs']]) if (await exists(source)) args.push('--ro-bind', source, destination);
    if (!configuration.nodeBinary.startsWith('/usr/') && !configuration.nodeBinary.startsWith('/bin/')) args.push('--ro-bind', configuration.nodeBinary, configuration.nodeBinary);
    for (const [name, value] of Object.entries(toolEnvironment)) args.push('--setenv', name, value);
    args.push(configuration.nodeBinary, '--input-type=commonjs', '--eval', configuration.workerSource);
  } else args = macosSandboxArgs({ ...configuration, network });
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: platform === 'darwin' ? configuration.temporaryDirectory : undefined, env: sandboxChildEnvironment({ ...configuration, platform, toolEnvironment }) });
  const turnWorker = new TurnWorker(child, {
    cleanup: () => cleanupTemporaryDirectory(configuration.temporaryDirectory),
    onUnexpectedExit: details => logError('[ok-workbench] sandbox worker exited unexpectedly', { backend, ...details }),
  });
  try { await waitForSpawn(child); await turnWorker.waitForReady(); return turnWorker; }
  catch (error) { turnWorker.close(); turnWorker.removeTemporaryDirectory(); throw error; }
}

function apiKeyFor(provider, env) {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY;
  if (provider === 'openai') return env.OPENAI_API_KEY;
  return undefined;
}

/**
 * Return only providers that Pi can authenticate in this process.  ModelRuntime
 * uses this browser's credential store, not Pi CLI's ~/.pi/agent/auth.json.
 * Credentials never cross the browser/server boundary.
 */
function credentialPath(stateDir) { return path.join(stateDir, 'pi-agent', 'auth.json'); }

export async function configuredPiProviders({ stateDir, env = process.env } = {}) {
  if (!stateDir) throw new Error('A browser credential directory is required');
  const runtime = await ModelRuntime.create({ authPath: credentialPath(stateDir), modelsPath: null, refreshOnCreate: false });
  const configured = [];
  for (const provider of runtime.getProviders()) {
    try {
      // A supplied environment is useful to callers/tests that do not run with
      // process.env. Pi otherwise resolves API-key environment variables itself.
      const apiKey = apiKeyFor(provider.id, env);
      if (apiKey) await runtime.setRuntimeApiKey(provider.id, apiKey);
      const models = await runtime.getAvailable(provider.id);
      if (models.length) configured.push({
        id: provider.id,
        label: provider.name || provider.id,
        models: models.map(model => ({
          id: model.id,
          label: model.name || model.id,
          // Pi maps only exceptional values. Unmapped low-through-high levels
          // use the provider default; xhigh and max require explicit support.
          thinkingLevels: model.reasoning ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => {
            const mapped = model.thinkingLevelMap?.[level];
            return mapped !== null && (level !== 'xhigh' && level !== 'max' || mapped !== undefined);
          }) : []
        }))
      });
    } catch {
      // One stale or unavailable provider credential must not hide the others.
    }
  }
  return configured;
}

/** Start an app-owned Pi OAuth flow. The caller supplies UI/event plumbing but
 * never receives a credential or token. */
export async function startPiLogin({ provider, stateDir, onEvent, onPrompt }) {
  if (!stateDir) throw new Error('A browser credential directory is required');
  const runtime = await ModelRuntime.create({ authPath: credentialPath(stateDir), modelsPath: null, refreshOnCreate: false });
  const controller = new AbortController();
  const complete = runtime.login(provider, 'oauth', {
    signal: controller.signal,
    notify: event => onEvent?.(event),
    prompt: prompt => new Promise((resolve, reject) => {
      const abort = () => reject(new Error('Authentication prompt cancelled'));
      prompt.signal?.addEventListener('abort', abort, { once: true });
      onPrompt?.(prompt, value => { prompt.signal?.removeEventListener('abort', abort); resolve(value); }, abort);
    })
  });
  return { complete, cancel: () => controller.abort() };
}

function historyPrompt(messages) {
  return messages.slice(-20).map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`).join('\n\n');
}
async function agentInstructionsFile(root, label) {
  const file = path.join(root, 'AGENTS.md');
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) return '';
    if (metadata.size > MAX_AGENT_INSTRUCTIONS) throw new Error(`${label} AGENTS.md is too large (maximum 64 KiB)`);
    const content = await readFile(file, 'utf8');
    return `\n\n[${label} instructions: AGENTS.md]\n${content.trim()}\n[End ${label.toLowerCase()} instructions]`;
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}
export async function workspaceAgentInstructions(workspaceRoot, projectRoot = workspaceRoot) {
  const workspace = path.resolve(workspaceRoot); const project = path.resolve(projectRoot);
  const workspaceInstructions = await agentInstructionsFile(workspace, 'Workspace');
  const projectInstructions = project === workspace ? '' : await agentInstructionsFile(project, 'Project');
  return `${workspaceInstructions}${projectInstructions}`;
}
export function projectToolResult(toolResult, git) {
  if (!git) return toolResult;
  const result = { ...(toolResult.details?.result || {}), git };
  return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { result } };
}

export async function runPiTurn({ provider, model: modelId, effort, messages, projectRoot, workspaceRoot = projectRoot, stateDir, env = process.env, signal, onDelta, onTool, beforeCreateProject, systemPrompt, noWorkspaceTools = false }) {
  if (!modelId) throw new Error(`Set a model for ${provider}`);
  const worker = noWorkspaceTools ? null : await createTurnWorker(workspaceRoot); const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
  const workspaceInstructions = systemPrompt ? '' : await workspaceAgentInstructions(workspaceRoot, projectRoot);
  const agentDir = path.join(stateDir, 'pi-agent');
  const modelRuntime = await ModelRuntime.create({ authPath: credentialPath(stateDir), modelsPath: null, refreshOnCreate: false });
  const apiKey = apiKeyFor(provider, env);
  if (apiKey) await modelRuntime.setRuntimeApiKey(provider, apiKey);
  const model = modelRuntime.getModel(provider, modelId); if (!model) throw new Error(`Pi does not recognise ${provider}/${modelId}`);
  const loader = new DefaultResourceLoader({
    cwd: projectRoot, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt || `You are an ok-workbench workspace assistant. You can access only the served workspace through the supplied tools. Use extract_document for PDF, DOCX, PPTX, XLSX, ODT, ODP, and ODS files; it returns extracted text and does not modify the file. Use list_workspace_tools before running a workspace tool. Only executable Python 3 or Node.js scripts directly in tools/ or <project>/tools/ are available; pass each argument as a separate string, never as a shell command. Use create_project to create a discoverable top-level project; it returns the canonical project ID and location, which you must report accurately. Use apply_project_update for substantive project edits: it requires the affected project's index.md, log.md, and status.md in the same update, plus an index.md for every new directory. When linking workspace files in a response, use workspace-relative Markdown paths such as [status](project/status.md). Never claim access or a completed change you do not have. Make concise, reviewable edits only when asked.${workspaceInstructions}`
  });
  await loader.reload();
  const call = async (name, params) => {
    if (!worker) throw new Error('A supported sandbox is required before agent file tools can run');
    await onTool?.({ phase: 'started', name });
    try {
      const result = await worker.call(name, params);
      if (name === 'list_workspace_tools' && result.diagnostics?.length) logError('[ok-workbench] workspace tool metadata diagnostics', { diagnostics: result.diagnostics });
      await onTool?.({ phase: 'completed', name, changed: name === 'apply_project_update' || name === 'create_project', result });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { result } };
    } catch (error) {
      await onTool?.({ phase: 'failed', name, error: error.message });
      throw error;
    }
  };
  const runWorkspaceTool = async params => {
    if (!worker) throw new Error('A supported sandbox is required before workspace tools can run');
    const name = 'run_workspace_tool'; await onTool?.({ phase: 'started', name });
    let runner; let policy;
    try {
      policy = await worker.call('workspace_tool_policy', params);
      const missing = policy.environment.filter(variable => typeof env[variable] !== 'string');
      if (missing.length) throw new Error(`Tool requires unset environment variable${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
      const toolEnvironment = Object.fromEntries(policy.environment.map(variable => [variable, env[variable]]));
      runner = await createTurnWorker(workspaceRoot, { network: policy.network, toolEnvironment });
      if (!runner) throw new Error('A supported sandbox is required before workspace tools can run');
      const result = await runner.call(name, params);
      if (result.stderr) logError('[ok-workbench] workspace tool stderr', { path: result.path, exitCode: result.exitCode, signal: result.signal, stderr: result.stderr, manifestPath: policy.manifestPath, manifest: policy.manifest, providedEnvironment: Object.keys(toolEnvironment) });
      await onTool?.({ phase: 'completed', name, result });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { result } };
    } catch (error) {
      if (/^Tool timed out after \d+ seconds$/.test(error.message)) logError('[ok-workbench] workspace tool timed out', { path: policy?.path || params.path, timeoutSeconds: policy?.timeoutSeconds, manifestPath: policy?.manifestPath, manifest: policy?.manifest });
      await onTool?.({ phase: 'failed', name, error: error.message }); throw error;
    } finally { runner?.close(); }
  };
  const tools = noWorkspaceTools ? [] : [
    defineTool({ name: 'list_files', label: 'List files', description: 'List files in the served workspace.', parameters: Type.Object({ path: Type.Optional(Type.String()) }), execute: (_id, params) => call('list_files', params) }),
    defineTool({ name: 'read_file', label: 'Read file', description: 'Read a text file in the served workspace.', parameters: Type.Object({ path: Type.String() }), execute: (_id, params) => call('read_file', params) }),
    defineTool({ name: 'extract_document', label: 'Extract document text', description: 'Extract text from a PDF, DOCX, PPTX, XLSX, ODT, ODP, or ODS file in the served workspace. Use this for non-text office documents instead of read_file.', parameters: Type.Object({ path: Type.String() }), execute: (_id, params) => call('extract_document', params) }),
    defineTool({ name: 'search_files', label: 'Search files', description: 'Search text files in the served workspace.', parameters: Type.Object({ query: Type.String() }), execute: (_id, params) => call('search_files', params) }),
    defineTool({ name: 'list_workspace_tools', label: 'List workspace tools', description: 'List executable Python 3 and Node.js scripts directly inside tools/ and each top-level project’s tools/ directory, including their declared environment-variable names, network policy, and timeout.', parameters: Type.Object({}), execute: (_id, params) => call('list_workspace_tools', params) }),
    defineTool({ name: 'run_workspace_tool', label: 'Run workspace tool', description: 'Run a discovered workspace tool without a shell. Provide its exact path and each argument as a separate string. Its colocated manifest controls which server environment variables it receives, whether it may use network access, and its timeout (30 seconds by default; up to 10 minutes).', parameters: Type.Object({ path: Type.String(), arguments: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })) }), execute: (_id, params) => runWorkspaceTool(params) }),
    defineTool({ name: 'apply_project_update', label: 'Apply OKF project update', description: 'Apply a reviewable batch of project files. Project updates must include the project root index.md, log.md, and status.md; each new nested directory must include its index.md.', parameters: Type.Object({ changes: Type.Array(Type.Object({ path: Type.String(), content: Type.String() }), { minItems: 1, maxItems: 64 }) }), execute: (_id, params) => call('apply_project_update', params) }),
    defineTool({ name: 'create_project', label: 'Create workspace project', description: 'Create and register a discoverable top-level project from the OKF project template. Use this instead of manually creating a project directory.', parameters: Type.Object({ id: Type.String(), title: Type.Optional(Type.String()) }), execute: async (_id, params) => {
      let git;
      try { git = await beforeCreateProject?.(); }
      catch (error) { await onTool?.({ phase: 'failed', name: 'create_project', error: `Git setup failed: ${error.message}` }); throw error; }
      const toolResult = await call('create_project', params);
      return projectToolResult(toolResult, git);
    } })
  ];
  const { session } = await createAgentSession({ cwd: projectRoot, agentDir, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(projectRoot), thinkingLevel: effort || undefined, noTools: 'builtin', tools: tools.map(tool => tool.name), customTools: tools });
  const unsubscribe = session.subscribe(event => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') onDelta(event.assistantMessageEvent.delta); });
  const abort = () => session.abort().catch(() => {}); signal?.addEventListener('abort', abort, { once: true });
  try { await session.prompt(historyPrompt(messages)); } finally { signal?.removeEventListener('abort', abort); unsubscribe(); session.dispose(); worker?.close(); }
}
