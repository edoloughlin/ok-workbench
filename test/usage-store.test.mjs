import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { UsageStore } = require('../src/usage-store.js');

test('journal persists cumulative checkpoints and ignores repeated terminal delivery', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, workspaceRoot: '/workspace', clock: () => new Date('2026-01-01T00:00:00Z') };
  const store = new UsageStore(options);
  await store.init();
  const op = await store.startOperation({ activity: 'chat', trigger: 'user', projectId: 'p1', prompt: 'secret' });
  const request = await store.startRequest({ operationId: op.operationId, activity: 'chat', requestedProvider: 'provider', requestedModel: 'model' });
  await store.checkpointRequest(request.requestId, { inputUncached: 4, totalTokens: 4, usageCoverage: 'partial' });
  await store.checkpointRequest(request.requestId, { inputUncached: 8, totalTokens: 8, usageCoverage: 'partial' });
  await store.finishRequest(request.requestId, { status: 'completed', totalTokens: 10, output: 2 });
  await store.finishRequest(request.requestId, { status: 'failed', totalTokens: 100 });
  const snapshot = await new UsageStore(options).snapshot();
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.requests[0].totalTokens, 10);
  assert.equal(snapshot.requests[0].status, 'completed');
  assert.equal(snapshot.operations[0].prompt, undefined);
  const journal = await fs.readFile(path.join(store.root, '2026-01.jsonl'), 'utf8');
  assert.ok(!journal.includes('secret'));
});

test('concurrent instances share ordered writes and live requests survive recovery', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, workspaceRoot: '/workspace' };
  const a = new UsageStore(options), b = new UsageStore(options);
  await Promise.all([a.init(), b.init()]);
  const op = await a.startOperation({ activity: 'chat' });
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).startRequest({ operationId: op.operationId })));
  await b.init();
  const snapshot = await a.snapshot();
  assert.equal(snapshot.requests.length, 10);
  assert.ok(snapshot.requests.every(r => r.status === 'in_flight'));
  assert.equal(new Set(snapshot.requests.map(r => r.requestId)).size, 10);
});

test('truncated tail is quarantined and reported after restart', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, workspaceRoot: '/workspace', clock: () => new Date('2026-01-01T00:00:00Z') };
  const a = new UsageStore(options); await a.init(); await a.startOperation({ activity: 'chat' });
  await fs.appendFile(path.join(a.root, '2026-01.jsonl'), '{"broken":');
  const b = new UsageStore(options); await b.init();
  assert.equal((await b.snapshot()).operations.length, 1);
  assert.equal((await new UsageStore(options).snapshot()).health.gaps[0].type, 'truncated_tail');
});

test('a request left by an exited process is recovered as interrupted with its last count', async t => {
  const { spawnSync } = await import('node:child_process');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const script = `const {UsageStore}=require(${JSON.stringify(require.resolve('../src/usage-store.js'))});
    (async()=>{const s=new UsageStore({stateDir:process.argv[1],workspaceRoot:'/workspace'});await s.init();
    const o=await s.startOperation({activity:'chat'});const r=await s.startRequest({operationId:o.operationId});
    await s.checkpointRequest(r.requestId,{totalTokens:9,usageCoverage:'partial'});})().catch(e=>{console.error(e);process.exitCode=1});`;
  const child = spawnSync(process.execPath, ['-e', script, stateDir], {encoding:'utf8'});
  assert.equal(child.status, 0, child.stderr);
  const store = new UsageStore({stateDir,workspaceRoot:'/workspace'}); await store.init();
  const [request] = (await store.snapshot()).requests;
  assert.equal(request.status, 'interrupted'); assert.equal(request.totalTokens, 9);
});

test('parallel processes serialize journal appends', async t => {
  const { spawn } = await import('node:child_process');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-'));
  t.after(() => fs.rm(stateDir, {recursive:true, force:true}));
  const store = new UsageStore({stateDir, workspaceRoot:'/workspace'}); await store.init();
  const operation = await store.startOperation({activity:'chat'});
  const script = `const {UsageStore}=require(${JSON.stringify(require.resolve('../src/usage-store.js'))});
    (async()=>{const s=new UsageStore({stateDir:process.argv[1],workspaceRoot:'/workspace'});
    for(let i=0;i<20;i++) await s.startRequest({operationId:process.argv[2]});})().catch(e=>{console.error(e);process.exitCode=1});`;
  const run = () => new Promise((resolve,reject) => { const child=spawn(process.execPath,['-e',script,stateDir,operation.operationId]); let stderr=''; child.stderr.on('data', data=>stderr+=data); child.on('error',reject); child.on('close',code=>code===0?resolve():reject(new Error(stderr))); });
  await Promise.all([run(),run()]);
  assert.equal((await new UsageStore({stateDir,workspaceRoot:'/workspace'}).snapshot()).requests.length,40);
});

test('failed start blocks persistence and failed terminal writes flag degraded health', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-'));
  t.after(() => fs.rm(stateDir, {recursive:true, force:true}));
  const store = new UsageStore({stateDir,workspaceRoot:'/workspace'}); await store.init();
  const operation = await store.startOperation({activity:'chat'});
  const originalOpen = fs.open;
  fs.open = async (...args) => { if (args[1] === 'a') throw Object.assign(new Error('simulated disk failure'),{code:'ENOSPC'}); return originalOpen(...args); };
  try { await assert.rejects(store.startRequest({operationId:operation.operationId}), {code:'USAGE_STORE_UNAVAILABLE'}); }
  finally { fs.open = originalOpen; }
  assert.equal((await store.snapshot()).requests.length,0);
  const request = await store.startRequest({operationId:operation.operationId});
  fs.open = async (...args) => { if (args[1] === 'a') throw Object.assign(new Error('simulated disk failure'),{code:'ENOSPC'}); return originalOpen(...args); };
  try {
    await assert.rejects(store.finishRequest(request.requestId,{status:'completed',totalTokens:42,output:12,usageCoverage:'partial'}), {code:'USAGE_STORE_UNAVAILABLE'});
    await assert.rejects(store.startRequest({operationId:operation.operationId}), {code:'USAGE_STORE_UNAVAILABLE'});
    await assert.rejects(store.snapshot(), {code:'USAGE_STORE_UNAVAILABLE'});
  } finally { fs.open = originalOpen; }
  const next = await store.startRequest({operationId:operation.operationId});
  const snapshot = await store.snapshot();
  assert.equal(snapshot.health.degraded,false); assert.equal(snapshot.requests[0].status,'completed');
  assert.equal(snapshot.requests[0].totalTokens,42); assert.equal(snapshot.requests[0].output,12);
  assert.equal(snapshot.requests[1].requestId,next.requestId);
});

test('published snapshots are immutable and retain the prior revision across updates', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-store-snapshot-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, workspaceRoot: '/workspace', clock: () => new Date('2026-01-01T00:00:00Z') };
  const first = new UsageStore(options); const other = new UsageStore(options); await first.init();
  const op=await first.startOperation({activity:'chat'}); const request=await first.startRequest({operationId:op.operationId});
  const old=await first.snapshot(); assert.equal(await first.snapshot(),old); assert.equal(Object.isFrozen(old.requests[0]),true);
  await other.finishRequest(request.requestId,{status:'completed',totalTokens:10});
  const updated=await first.snapshot(); assert.notEqual(updated.revision,old.revision); assert.equal(old.requests[0].status,'in_flight'); assert.equal(updated.requests[0].totalTokens,10);
});
