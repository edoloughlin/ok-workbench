import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pythonRequest, pythonSandboxArgs, runPython } from '../src/python-runner.mjs';

const env = { OK_WORKBENCH_PYTHON: '1' };
test('Python requires operator opt-in and validates package policy before execution', () => {
  assert.throws(() => pythonRequest({ code: 'print(1)', artifacts: [] }, {}), /disabled/);
  assert.deepEqual(pythonRequest({ code: 'print(1)', artifacts: [], packages: ['Pillow', 'numpy==2.2.0'] }, env).packages, ['Pillow', 'numpy==2.2.0']);
  for (const spec of ['--index-url=x', 'https://example.com/x.whl', './x', '-r requirements.txt', 'Pillow[extra]', 'Pillow\n--help', 'unapproved', 'numpy>=1']) {
    assert.throws(() => pythonRequest({ code: 'pass', artifacts: [], packages: [spec] }, env), /allowed package names/);
  }
  assert.throws(() => pythonRequest({ code: 'pass', artifacts: [], packages: ['numpy'] }, { ...env, OK_WORKBENCH_PYTHON_PACKAGES: '' }), /allowed package names/);
  assert.deepEqual(pythonRequest({ code: 'pass', artifacts: [], packages: ['pandas'] }, { ...env, OK_WORKBENCH_PYTHON_PACKAGES: 'pandas' }).packages, ['pandas']);
});

test('Python rejects unsafe inputs and unbounded requests', () => {
  for (const input of ['../secret', '/etc/passwd', '.env', 'a/.git/config', 'a/../b', 'a\\b', 'credentials', 'a/private.pem']) {
    assert.throws(() => pythonRequest({ code: 'pass', artifacts: [], inputs: [input] }, env), /relative file paths/);
  }
  for (const request of [{ code: '', artifacts: [] }, { code: 'x'.repeat(65537), artifacts: [] }, { code: 'pass', artifacts: [], timeoutSeconds: 121 }, { code: 'pass', artifacts: [], stdin: 'x'.repeat(65537) }, { code: 'pass', artifacts: [], arguments: ['\0'] }]) {
    assert.throws(() => pythonRequest(request, env));
  }
  assert.throws(() => pythonRequest({ code: 'pass' }, env), /explicit array/);
  for (const artifact of [
    { staged_path: 'result.png', project_path: 'result.png', preserve: true },
    { staged_path: '/output/../result.png', project_path: 'result.png', preserve: true },
    { staged_path: '/output/result.png', project_path: '/tmp/result.png', preserve: true },
    { staged_path: '/output/result.png', project_path: '.env', preserve: true },
    { staged_path: '/output/result.png', project_path: 'tools/result.py', preserve: true },
    { staged_path: '/output/result.png', project_path: 'result.tool.json', preserve: true },
    { staged_path: '/output/result.png', project_path: 'result.png', preserve: 'yes' },
  ]) assert.throws(() => pythonRequest({ code: 'pass', artifacts: [artifact] }, env));
  assert.throws(() => pythonRequest({ code: 'pass', artifacts: [
    { staged_path: '/output/a', project_path: 'same', preserve: true },
    { staged_path: '/output/b', project_path: 'same', preserve: true },
  ] }, env), /duplicated/);
});

test('installation and execution have separate filesystem and network capabilities', () => {
  const base = { input: '/staged-input', output: '/staged-output', packages: '/staged-packages', pythonArgs: ['-I', '-c', 'pass'] };
  const execution = pythonSandboxArgs(base);
  assert.ok(execution.args.includes('--unshare-all'));
  assert.ok(!execution.args.includes('--share-net'));
  assert.ok(execution.args.includes('--clearenv'));
  assert.ok(execution.args.includes('--as=4294967296'));
  assert.deepEqual(execution.command.slice(0, 2), ['/usr/bin/python3', '-I']);
  const installer = pythonSandboxArgs({ ...base, install: true });
  assert.ok(installer.args.includes('--share-net'));
  assert.ok(!installer.args.includes('/staged-input'));
  assert.ok(!installer.args.includes('/staged-output'));
});

const probe = process.platform === 'linux' && spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/', '/', '/usr/bin/true']);
const sandboxAvailable = probe && probe.status === 0;
if (process.env.OK_WORKBENCH_REQUIRE_PYTHON_TESTS === '1') assert.ok(sandboxAvailable, 'Python sandbox integration tests are required');
test('Python sandbox handles input, stdin, arguments and artifacts while denying host writes and network', { skip: !sandboxAvailable }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ok-python-test-'));
  try {
    await writeFile(path.join(root, 'data.csv'), 'x,y\n2,3\n');
    const result = await runPython({ inputs: ['data.csv'], arguments: ['hello "world"', '☘'], stdin: 'input\n', artifacts: [
      { staged_path: '/output/result.json', project_path: 'result.json', preserve: true },
      { staged_path: '/output/intermediate.txt', project_path: 'ignored.txt', preserve: false },
    ], code: `import csv, json, os, socket, sys
assert list(csv.DictReader(open('data.csv')))[0]['x'] == '2'
assert sys.argv[1:] == ['hello "world"', '☘']
assert sys.stdin.read() == 'input\\n'
assert not os.path.exists(${JSON.stringify(root)})
assert 'SOME_SECRET' not in os.environ
try:
    open('/workspace/data.csv', 'w')
    raise AssertionError('input writable')
except OSError:
    pass
try:
    socket.create_connection(('1.1.1.1', 443), timeout=0.2)
    raise AssertionError('network available')
except OSError:
    pass
open('/output/result.json', 'w').write(json.dumps({'sum': 5}))
open('/output/intermediate.txt', 'w').write('discard me')
print('done')` }, { projectRoot: root, env: { ...env, SOME_SECRET: 'not-for-python' } });
    assert.equal(result.ok, true, result.stderr);
    assert.equal(result.stdout, 'done\n');
    assert.equal(result.artifacts.length, 1);
    assert.deepEqual(result.artifacts[0], { staged_path: '/output/result.json', project_path: 'result.json', preserve: true, bytes: 10 });
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'result.json'))), { sum: 5 });
    await assert.rejects(readFile(path.join(root, 'ignored.txt')), /ENOENT/);
    assert.ok(!(await readdir(root)).some(name => name.startsWith('python-output-')));
    assert.equal(await readFile(path.join(root, 'data.csv'), 'utf8'), 'x,y\n2,3\n');
    await assert.rejects(runPython({ code: "open('/output/result.json', 'w').write('replacement')", artifacts: [{ staged_path: '/output/result.json', project_path: 'result.json', preserve: true }] }, { projectRoot: root, env }), /already exists/);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'result.json'))), { sum: 5 });
    await assert.rejects(runPython({ code: 'pass', artifacts: [{ staged_path: '/output/missing', project_path: 'missing', preserve: true }] }, { projectRoot: root, env }), /does not exist/);
    await assert.rejects(runPython({ code: "open('/output/file', 'w').write('x')", artifacts: [{ staged_path: '/output/file', project_path: 'missing-dir/file', preserve: true }] }, { projectRoot: root, env }), /directory does not exist/);
    await mkdir(path.join(root, 'linked-target'));
    await symlink(path.join(root, 'linked-target'), path.join(root, 'linked-dir'));
    await assert.rejects(runPython({ code: "open('/output/file', 'w').write('x')", artifacts: [{ staged_path: '/output/file', project_path: 'linked-dir/file', preserve: true }] }, { projectRoot: root, env }), /unsafe/);
    await symlink('/etc/passwd', path.join(root, 'link'));
    await assert.rejects(runPython({ code: 'pass', artifacts: [], inputs: ['link'] }, { projectRoot: root, env }), /symbolic links/);
    await assert.rejects(runPython({ code: "import os; os.symlink('/etc/passwd', '/output/leak')", artifacts: [{ staged_path: '/output/leak', project_path: 'leak', preserve: true }] }, { projectRoot: root, env }), /symbolic links/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Python reports exceptions, caps output, enforces timeout and cancellation', { skip: !sandboxAvailable }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ok-python-test-'));
  try {
    const failed = await runPython({ code: "open('/output/not-promoted', 'w').write('x'); raise ValueError('example')", artifacts: [{ staged_path: '/output/not-promoted', project_path: 'not-promoted', preserve: true }] }, { projectRoot: root, env });
    assert.equal(failed.ok, false);
    assert.match(failed.stderr, /ValueError: example/);
    assert.deepEqual(failed.artifacts, []);
    await assert.rejects(readFile(path.join(root, 'not-promoted')), /ENOENT/);
    const streams = await runPython({ code: "import sys; print('model output'); print('diagnostic', file=sys.stderr)", artifacts: [] }, { projectRoot: root, env });
    assert.equal(streams.stdout, 'model output\n');
    assert.equal(streams.stderr, 'diagnostic\n');
    assert.deepEqual(streams.artifacts, []);
    const large = await runPython({ code: "print('x' * 100000)", artifacts: [] }, { projectRoot: root, env });
    assert.equal(large.truncated, true);
    assert.equal(Buffer.byteLength(large.stdout), 65536);
    await assert.rejects(runPython({ code: 'import time; time.sleep(30)', artifacts: [], timeoutSeconds: 1 }, { projectRoot: root, env }), /timed out/);
    const controller = new AbortController();
    const running = runPython({ code: 'import time; time.sleep(30)', artifacts: [] }, { projectRoot: root, env, signal: controller.signal });
    setTimeout(() => controller.abort(), 250);
    await assert.rejects(running, /cancelled|aborted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Python installs requested wheels and uses native image and numerical dependencies', { skip: !sandboxAvailable || process.env.OK_WORKBENCH_TEST_PYPI !== '1' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ok-python-test-'));
  try {
    const result = await runPython({ packages: ['Pillow', 'CairoSVG', 'opencv-python-headless', 'numpy'], artifacts: [
      { staged_path: '/output/red.png', project_path: 'red.png', preserve: true },
      { staged_path: '/output/blue.png', project_path: 'blue.png', preserve: true },
    ], code: `from PIL import Image
import cairosvg, cv2, numpy as np
Image.new('RGB', (8, 8), 'red').save('/output/red.png')
cairosvg.svg2png(bytestring=b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>', write_to='/output/blue.png')
assert cv2.imread('/output/red.png').shape == (8, 8, 3)
assert np.arange(4).sum() == 6
print('dependencies work')` }, { projectRoot: root, env });
    assert.equal(result.ok, true, result.stderr);
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.stdout, 'dependencies work\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
