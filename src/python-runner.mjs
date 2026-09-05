import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const DEFAULT_PACKAGES = 'Pillow,CairoSVG,opencv-python-headless,numpy';
const normalize = value => value.toLowerCase().replace(/[-_.]+/g, '-');
let active = false;

export function pythonRequest(params, env = process.env) {
  if (env.OK_WORKBENCH_PYTHON !== '1') throw new Error('Python is disabled. Set OK_WORKBENCH_PYTHON=1 on the server to enable it.');
  if (!params || typeof params.code !== 'string' || !params.code.trim() || Buffer.byteLength(params.code) > 64 * 1024) throw new Error('Python code must be nonempty and under 64 KiB');
  const timeoutSeconds = params.timeoutSeconds ?? 30;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error('Python timeoutSeconds must be from 1 to 120');
  const packages = params.packages ?? [];
  const allowed = new Set((env.OK_WORKBENCH_PYTHON_PACKAGES ?? DEFAULT_PACKAGES).split(',').filter(Boolean).map(value => normalize(value.trim())));
  if (!Array.isArray(packages) || packages.length > 16) throw new Error('Provide at most 16 Python packages');
  for (const requirement of packages) {
    const match = typeof requirement === 'string' && requirement.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:==([0-9][A-Za-z0-9.!+_-]{0,63}))?$/);
    if (!match || !allowed.has(normalize(match[1]))) throw new Error('Python packages must be allowed package names, optionally pinned with ==version; URLs, paths, flags, and requirements files are not accepted');
  }
  const inputs = params.inputs ?? [];
  if (!Array.isArray(inputs) || inputs.length > 64) throw new Error('Provide at most 64 input files');
  for (const input of inputs) safeInput(input);
  const args = params.arguments ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096)) throw new Error('Python arguments must be up to 32 short strings');
  const stdin = params.stdin ?? '';
  if (typeof stdin !== 'string' || Buffer.byteLength(stdin) > 64 * 1024) throw new Error('Python stdin must be under 64 KiB');
  const artifacts = artifactManifest(params.artifacts);
  return { code: params.code, timeoutSeconds, packages: [...new Set(packages)], inputs: [...new Set(inputs)], arguments: args, stdin, artifacts };
}

function safeInput(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '..' || part.startsWith('.') || ['credentials', 'id_rsa', 'id_ed25519', 'known_hosts'].includes(part) || /\.(pem|key|p12|pfx)$/i.test(part))) throw new Error('Python inputs must be relative file paths without hidden, credential, or parent components');
  return value;
}

function safeProjectArtifact(value) {
  const safe = safeInput(value);
  if (safe.split('/')[0] === 'tools' || safe.endsWith('.tool.json')) throw new Error('Python artifacts cannot create workspace tools or tool manifests');
  return safe;
}

function artifactManifest(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Python artifacts must be an explicit array of at most 64 entries; use an empty array to preserve nothing');
  const destinations = new Set();
  return value.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || Object.keys(artifact).some(key => !['staged_path', 'project_path', 'preserve'].includes(key))) throw new Error(`Python artifact ${index + 1} has invalid fields`);
    if (typeof artifact.preserve !== 'boolean') throw new Error(`Python artifact ${index + 1} preserve must be true or false`);
    if (typeof artifact.staged_path !== 'string' || !artifact.staged_path.startsWith('/output/')) throw new Error(`Python artifact ${index + 1} staged_path must be under /output`);
    const staged = safeInput(artifact.staged_path.slice('/output/'.length));
    const project = safeProjectArtifact(artifact.project_path);
    if (artifact.preserve && destinations.has(project)) throw new Error(`Python artifact destination is duplicated: ${project}`);
    if (artifact.preserve) destinations.add(project);
    return { staged_path: `/output/${staged}`, project_path: project, preserve: artifact.preserve };
  });
}

async function stageInputs(projectRoot, inputs, destination) {
  const root = await realpath(projectRoot);
  let total = 0;
  for (const relative of inputs) {
    let source = root;
    for (const part of relative.split('/')) {
      source = path.join(source, part);
      if ((await lstat(source)).isSymbolicLink()) throw new Error('Python inputs cannot contain symbolic links');
    }
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || (total += info.size) > MAX_BYTES) throw new Error('Python inputs must be regular files totaling at most 256 MiB');
      const target = path.join(destination, relative);
      await mkdir(path.dirname(target), { recursive: true });
      // Read through the checked descriptor, not a subsequently replaced path.
      await file.readFile().then(async data => {
        const output = await open(target, 'wx', 0o600);
        try { await output.writeFile(data); } finally { await output.close(); }
      });
    } finally { await file.close(); }
  }
}

export function pythonSandboxArgs({ input, output, packages, install = false, timeoutSeconds = 30, pythonArgs }) {
  const args = ['--as=4294967296', `--cpu=${timeoutSeconds}`, '--fsize=268435456', '--nofile=128', '--core=0', '--', '/usr/bin/bwrap',
    '--unshare-all', ...(install ? ['--share-net'] : []), '--new-session', '--die-with-parent', '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PIP_CONFIG_FILE', '/dev/null', '--setenv', 'OPENBLAS_NUM_THREADS', '1', '--setenv', 'OMP_NUM_THREADS', '1',
    '--tmpfs', '/', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  // System runtime mounts are appended by the caller after checking existence.
  if (install) args.push('--bind', packages, '/packages', '--chdir', '/tmp');
  else args.push('--ro-bind', input, '/workspace', '--bind', output, '/output', '--ro-bind', packages, '/packages', '--chdir', '/workspace');
  return { args, command: ['/usr/bin/python3', ...pythonArgs] };
}

async function executeSandbox(configuration, { signal, stdin = '' } = {}) {
  signal?.throwIfAborted();
  const { args, command } = pythonSandboxArgs(configuration);
  for (const entry of ['/lib', '/lib64']) {
    if (await access(entry).then(() => true, () => false)) args.push('--ro-bind', entry, entry);
  }
  if (configuration.install) {
    args.push('--dir', '/etc', '--dir', '/etc/ssl');
    for (const entry of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl/certs']) {
      if (await access(entry).then(() => true, () => false)) args.push('--ro-bind', entry, entry);
    }
  }
  args.push(...command);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/prlimit', args, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let truncated = false; let failure;
    const capture = (current, chunk) => { if (current.length + chunk.length > MAX_OUTPUT) truncated = true; return Buffer.concat([current, chunk.subarray(0, MAX_OUTPUT - current.length)]); };
    child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });
    const stop = message => { failure = new Error(message); child.kill('SIGKILL'); };
    const abort = () => stop('Python operation cancelled');
    const timer = setTimeout(() => stop(`Python operation timed out after ${configuration.timeoutSeconds} seconds`), configuration.timeoutSeconds * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    child.once('error', error => { failure = error; });
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ ok: exitCode === 0, exitCode, signal: exitSignal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated });
    });
  });
}

async function regularStagedArtifact(output, relative) {
  let target = output;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    const info = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) throw new Error(`Declared Python artifact does not exist: /output/${relative}`);
    if (info.isSymbolicLink()) throw new Error('Declared Python artifacts cannot contain symbolic links');
  }
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await file.stat();
  if (!info.isFile() || info.nlink !== 1) { await file.close(); throw new Error('Declared Python artifacts must be regular files with one link'); }
  return { file, bytes: info.size };
}

async function projectArtifactTarget(root, relative) {
  const parent = path.posix.dirname(relative);
  let directory = root;
  if (parent !== '.') for (const part of parent.split('/')) {
    directory = path.join(directory, part);
    const info = await lstat(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Python artifact destination directory does not exist or is unsafe: ${parent}`);
  }
  const realParent = await realpath(directory);
  if (realParent !== root && !realParent.startsWith(`${root}${path.sep}`)) throw new Error('Python artifact destination escapes the project');
  const target = path.join(directory, path.posix.basename(relative));
  if (await lstat(target).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error(`Python artifact destination already exists: ${relative}`);
  return target;
}

async function promoteArtifacts(output, projectRoot, manifest) {
  const selected = manifest.filter(artifact => artifact.preserve);
  if (!selected.length) return [];
  const root = await realpath(projectRoot);
  const prepared = []; let total = 0;
  try {
    for (const artifact of selected) {
      const relative = artifact.staged_path.slice('/output/'.length);
      const source = await regularStagedArtifact(output, relative);
      let target;
      try { target = await projectArtifactTarget(root, artifact.project_path); }
      catch (error) { await source.file.close(); throw error; }
      if ((total += source.bytes) > MAX_BYTES) { await source.file.close(); throw new Error('Preserved Python artifacts total more than 256 MiB'); }
      prepared.push({ ...artifact, source, target });
    }
    const promoted = []; const created = [];
    try {
      for (const artifact of prepared) {
        const destination = await open(artifact.target, 'wx', 0o600);
        created.push(artifact.target);
        try { await destination.writeFile(await artifact.source.file.readFile()); }
        finally { await destination.close(); }
        promoted.push({ staged_path: artifact.staged_path, project_path: artifact.project_path, preserve: true, bytes: artifact.source.bytes });
      }
      return promoted;
    } catch (error) {
      for (const target of created) await rm(target, { force: true }).catch(() => {});
      throw error;
    }
  } finally {
    for (const artifact of prepared) await artifact.source.file.close().catch(() => {});
  }
}

export async function runPython(params, options = {}) {
  if (active) throw new Error('Another Python operation is running; retry when it finishes');
  active = true;
  try { return await runPythonInvocation(params, options); }
  finally { active = false; }
}

async function runPythonInvocation(params, { projectRoot, env = process.env, signal } = {}) {
  const request = pythonRequest(params, env);
  if (process.platform !== 'linux') throw new Error('General Python execution currently requires Linux with Bubblewrap; no unsandboxed fallback is available');
  for (const executable of ['/usr/bin/bwrap', '/usr/bin/prlimit', '/usr/bin/python3']) {
    await access(executable, constants.X_OK).catch(() => { throw new Error(`Python requires ${executable}`); });
  }
  signal?.throwIfAborted();
  const scratch = await mkdtemp(path.join(tmpdir(), 'ok-workbench-python-'));
  const input = path.join(scratch, 'input'); const output = path.join(scratch, 'output'); const packages = path.join(scratch, 'packages');
  try {
    await Promise.all([input, output, packages].map(directory => mkdir(directory, { mode: 0o700 })));
    await stageInputs(projectRoot, request.inputs, input);
    let installation;
    if (request.packages.length) {
      installation = await executeSandbox({ packages, install: true, timeoutSeconds: 120, pythonArgs: ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', '--no-cache-dir', '--no-compile', '--no-input', '--retries', '1', '--timeout', '15', '--target', '/packages', ...request.packages] }, { signal });
      if (!installation.ok) return { ...installation, phase: 'install', artifacts: [], paths: [], packages: request.packages };
    }
    // -S skips site startup and .pth execution. Append dependencies after the
    // standard library so a wheel cannot shadow launcher imports at startup.
    const bootstrap = `import sys, json\nsys.path.append('/packages')\nsys.argv = ['<python>'] + json.loads(${JSON.stringify(JSON.stringify(request.arguments))})\nexec(compile(${JSON.stringify(request.code)}, '<python>', 'exec'), {'__name__': '__main__'})`;
    const result = await executeSandbox({ input, output, packages, timeoutSeconds: request.timeoutSeconds, pythonArgs: ['-I', '-S', '-u', '-c', bootstrap] }, { signal, stdin: request.stdin });
    const artifacts = result.ok ? await promoteArtifacts(output, projectRoot, request.artifacts) : [];
    return { ...result, phase: 'execute', artifacts, paths: artifacts.map(file => file.project_path), packages: request.packages };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
