import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { UsageStore } = require('../src/usage-store.js');
const { createUsageCapture } = require('../src/usage-capture.js');

test('capture records physical identity and replaces cumulative snapshots before finish', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-capture-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const store = new UsageStore({ stateDir, workspaceRoot: '/workspace' }); await store.init();
  const op = await store.startOperation({ activity:'chat', projectId:'original' });
  const capture = createUsageCapture({ store, context:{ operationId:op.operationId, activity:'chat', projectId:'original', requestedProvider:'wanted', requestedModel:'wanted-model' } });
  const attempt = await capture({ provider:'actual', model:'physical', attempt:1 });
  await attempt.onUsage({ format:'openai-responses', usage:{input_tokens:1000,input_tokens_details:{cached_tokens:400},output_tokens:200,output_tokens_details:{reasoning_tokens:50},total_tokens:1200} });
  await attempt.onFinish({status:'completed'});
  const [r] = (await store.snapshot()).requests;
  assert.equal(r.projectId,'original'); assert.equal(r.model,'physical');
  assert.equal(r.inputUncached,600); assert.equal(r.cacheRead,400); assert.equal(r.totalTokens,1200); assert.equal(r.reasoning,50);
});
