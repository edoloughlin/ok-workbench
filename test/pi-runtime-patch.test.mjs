import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import patch from '../src/pi-runtime-patch.js';
import { createInferenceObserver } from '../src/pi-inference-hooks.mjs';

test('physical lifecycle awaits durable start, preserves retry lineage and sends cumulative checkpoints', async () => {
  const calls = [];
  let release;
  const durable = new Promise(resolve => { release = resolve; });
  const observer = createInferenceObserver({ onInferenceAttempt: async metadata => {
    calls.push(['start', metadata]);
    await durable;
    return { requestId: metadata.requestId, onUsage: data => calls.push(['usage', data]), onFinish: data => calls.push(['finish', data]) };
  } }, { provider: 'local', id: 'm', api: 'openai-completions' });
  let permitted = false;
  const pending = observer.start('http').then(() => { permitted = true; });
  await Promise.resolve();
  assert.equal(permitted, false);
  release();
  await pending;
  await observer.usage({ total_tokens: 10 }, 'openai-completions');
  await observer.usage({ total_tokens: 12 }, 'openai-completions');
  await observer.finish('failed');
  await observer.start('http');
  await observer.finish();
  await observer.finish();
  assert.deepEqual(calls.filter(([kind]) => kind === 'usage').map(([,data]) => data.usage.total_tokens), [10,12]);
  const starts = calls.filter(([kind]) => kind === 'start').map(([,data]) => data);
  assert.equal(starts[1].retryOfRequestId, starts[0].requestId);
  assert.notEqual(starts[1].requestId, starts[0].requestId);
  assert.deepEqual(calls.filter(([kind]) => kind === 'finish').map(([,data]) => data.status), ['failed','completed']);
});

test('accounting failure is sticky and strips provider retry metadata', async () => {
  let starts = 0;
  const observer = createInferenceObserver({ onInferenceAttempt: () => {
    starts++;
    throw Object.assign(new Error('private body'), { usageAccountingFailure: true, status: 503, $retryable: {}, $metadata: { httpStatusCode: 503 } });
  } }, { provider: 'p', id: 'm', api: 'a' });
  await assert.rejects(observer.start('http'), error => error.code === 'USAGE_STORE_UNAVAILABLE' && error.status === undefined && error.$metadata === undefined && !error.message.includes('private'));
  await assert.rejects(observer.start('http'), { code: 'USAGE_STORE_UNAVAILABLE' });
  assert.equal(starts, 1);
});

test('patch installation is idempotent and rejects unknown source before any mutation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-runtime-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'authored');
  const targetRoot = path.join(root, 'runtime');
  await mkdir(path.join(sourceDir, 'pi-runtime-patches'), { recursive: true });
  await mkdir(path.join(targetRoot, 'dist'), { recursive: true });
  await writeFile(path.join(sourceDir, 'pi-inference-hooks.mjs'), 'export const test = true;\n');
  const original = 'export const original = true;\n';
  const manifest = [{ file: 'adapter.js', sha256: createHash('sha256').update(original).digest('hex'), replacements: [{ before: 'original', after: 'patched' }] }];
  await writeFile(path.join(sourceDir, 'pi-runtime-patches', 'common.json'), JSON.stringify(manifest));
  const target = path.join(targetRoot, 'dist', 'adapter.js');
  await writeFile(target, original);
  const options = { sourceDir, resolvePackage: async () => targetRoot };
  assert.equal((await patch.applyPiRuntimePatches(options)).changedFiles, 2);
  assert.equal((await patch.applyPiRuntimePatches(options)).changedFiles, 0);
  await writeFile(target, 'unknown version');
  await assert.rejects(patch.applyPiRuntimePatches(options), { code: 'PI_INFERENCE_PATCH_UNSUPPORTED' });
  assert.equal(await readFile(target, 'utf8'), 'unknown version');
});
