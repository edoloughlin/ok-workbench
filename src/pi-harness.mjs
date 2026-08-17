import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
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

async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function bwrapPath() {
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) if (await exists(candidate)) return candidate;
  return null;
}

class TurnWorker {
  constructor(child) {
    this.child = child; this.pending = new Map(); this.sequence = 0; this.buffer = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => this.read(chunk));
    child.on('exit', () => this.failAll(new Error('Sandbox worker exited')));
  }
  read(chunk) {
    this.buffer += chunk; const lines = this.buffer.split('\n'); this.buffer = lines.pop();
    for (const line of lines) try { const response = JSON.parse(line); const pending = this.pending.get(response.id); if (!pending) continue; this.pending.delete(response.id); response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error || 'Workspace operation failed')); } catch { /* malformed worker response is ignored */ }
  }
  failAll(error) { for (const { reject } of this.pending.values()) reject(error); this.pending.clear(); }
  call(operation, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child.stdin.write(`${JSON.stringify({ id, operation, params })}\n`); });
  }
  close() { this.child.kill('SIGTERM'); this.failAll(new Error('Sandbox worker closed')); }
}

async function createTurnWorker(projectRoot) {
  const bwrap = await bwrapPath();
  if (!bwrap) return null;
  // The worker source is passed as an evaluated program so the sandbox never
  // mounts the package installation or seed bundle. Its only user-data mount
  // is the selected project at /workspace.
  const workerSource = await readFile(WORKER, 'utf8');
  const args = ['--unshare-all', '--new-session', '--die-with-parent', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'OK_WORKSPACE_ROOT', '/workspace', '--setenv', 'OKF_WORKSPACE_ROOT', '/workspace', '--tmpfs', '/', '--dir', '/workspace', '--bind', projectRoot, '/workspace', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/workspace'];
  for (const systemPath of ['/usr', '/bin', '/lib', '/lib64']) if (await exists(systemPath)) args.push('--ro-bind', systemPath, systemPath);
  // Node may be installed under nvm rather than /usr/bin; bind the executable
  // itself, not its home directory or any credentials alongside it.
  if (!process.execPath.startsWith('/usr/') && !process.execPath.startsWith('/bin/')) args.push('--ro-bind', process.execPath, process.execPath);
  args.push(process.execPath, '--input-type=commonjs', '--eval', workerSource);
  const child = spawn(bwrap, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return new TurnWorker(child);
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

export async function runPiTurn({ provider, model: modelId, effort, messages, projectRoot, stateDir, env = process.env, signal, onDelta, onTool, systemPrompt, noWorkspaceTools = false }) {
  if (!modelId) throw new Error(`Set a model for ${provider}`);
  const worker = noWorkspaceTools ? null : await createTurnWorker(projectRoot); const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
  const agentDir = path.join(stateDir, 'pi-agent');
  const modelRuntime = await ModelRuntime.create({ authPath: credentialPath(stateDir), modelsPath: null, refreshOnCreate: false });
  const apiKey = apiKeyFor(provider, env);
  if (apiKey) await modelRuntime.setRuntimeApiKey(provider, apiKey);
  const model = modelRuntime.getModel(provider, modelId); if (!model) throw new Error(`Pi does not recognise ${provider}/${modelId}`);
  const loader = new DefaultResourceLoader({
    cwd: projectRoot, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt || 'You are an ok-workbench project assistant. You can access only the selected project through the supplied tools. Never claim access you do not have. Make concise, reviewable edits only when asked.'
  });
  await loader.reload();
  const call = async (name, params) => {
    if (!worker) throw new Error('Bubblewrap is required before agent file tools can run');
    onTool?.({ phase: 'started', name });
    const result = await worker.call(name, params);
    onTool?.({ phase: 'completed', name, changed: name === 'apply_patch', result });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { result } };
  };
  const tools = noWorkspaceTools ? [] : [
    defineTool({ name: 'list_files', label: 'List files', description: 'List files in the selected project.', parameters: Type.Object({ path: Type.Optional(Type.String()) }), execute: (_id, params) => call('list_files', params) }),
    defineTool({ name: 'read_file', label: 'Read file', description: 'Read a text file in the selected project.', parameters: Type.Object({ path: Type.String() }), execute: (_id, params) => call('read_file', params) }),
    defineTool({ name: 'search_files', label: 'Search files', description: 'Search text files in the selected project.', parameters: Type.Object({ query: Type.String() }), execute: (_id, params) => call('search_files', params) }),
    defineTool({ name: 'apply_patch', label: 'Apply file replacement', description: 'Replace a selected project text file with the supplied content.', parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: (_id, params) => call('apply_patch', params) })
  ];
  const { session } = await createAgentSession({ cwd: projectRoot, agentDir, model, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(projectRoot), thinkingLevel: effort || undefined, noTools: 'builtin', tools: tools.map(tool => tool.name), customTools: tools });
  const unsubscribe = session.subscribe(event => { if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') onDelta(event.assistantMessageEvent.delta); });
  const abort = () => session.abort().catch(() => {}); signal?.addEventListener('abort', abort, { once: true });
  try { await session.prompt(historyPrompt(messages)); } finally { signal?.removeEventListener('abort', abort); unsubscribe(); session.dispose(); worker?.close(); }
}
