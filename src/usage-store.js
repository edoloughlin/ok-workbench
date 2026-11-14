'use strict';

// The journal is the authority. Only explicitly allowlisted metadata can cross
// this boundary; provider payloads, prompts and error messages never do.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { workspaceKey } = require('./workspace-review-store.js');
const VERSION = 1;
const MAX_EVENT_BYTES = 16384;
const operationFields = ['operationId','workspaceKey','projectId','projectLabel','activity','trigger','startedAt','completedAt','status','promptSubmissions','stages','reuse'];
const requestFields = ['requestId','operationId','workspaceKey','projectId','projectLabel','attributionStatus','activity','subtask','trigger','requestedProvider','requestedModel','provider','model','modelIdentitySource','startedAt','completedAt','status','retryOfRequestId','attempt','validationOutcome','inputUncached','cacheRead','cacheWrite','output','reasoning','totalTokens','usageCoverage','usageSource','normalizerVersion','errorCode','mismatch'];
const usageFields = ['inputUncached','cacheRead','cacheWrite','output','reasoning','totalTokens','usageCoverage','usageSource','normalizerVersion','mismatch','provider','model','modelIdentitySource'];
const terminalFields = [...usageFields, 'status','completedAt','errorCode'];
const enums = {activity:['chat','project_review','workspace_review','progress_report','system'], subtask:['generation','tool_continuation','compaction','other'], trigger:['user','automatic','system'], attributionStatus:['known','unattributed'], modelIdentitySource:['runtime','provider','requested_only','unknown'], status:['in_flight','completed','failed','aborted','interrupted'], validationOutcome:['not_applicable','pending','accepted','rejected'], usageCoverage:['complete','partial','unavailable'], usageSource:['provider','runtime','unavailable']};
const counts = new Set(['inputUncached','cacheRead','cacheWrite','output','reasoning','totalTokens']);
function pick(input, fields) {
  const result = {};
  for (const key of fields) {
    let v = input?.[key];
    if (v === undefined) continue;
    if (counts.has(key)) v = Number.isSafeInteger(v) && v >= 0 ? v : null;
    else if (enums[key]) { if (!enums[key].includes(v)) continue; }
    else if (key === 'promptSubmissions') {
      if (!Array.isArray(v)) continue;
      v = v.slice(0, 1000).map(x => ({ id: safeString(x?.id), acceptedAt: safeDate(x?.acceptedAt) })).filter(x => x.id && x.acceptedAt);
    } else if (key === 'stages' || key === 'reuse') {
      // Bounded, safe summaries only; never persist free-form stage details.
      if (!Array.isArray(v)) continue;
      v = v.slice(0, 1000).map(x => ({ stage: safeString(x?.stage), projectId: safeString(x?.projectId), outcome: safeString(x?.outcome) }));
    } else if (key === 'errorCode') { if (v !== null && (typeof v !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(v))) v = null; }
    else if (key === 'mismatch') v = v === true;
    else if (key === 'attempt' || key === 'normalizerVersion') { if (!Number.isSafeInteger(v) || v < 1) continue; }
    else if (key.endsWith('At')) { v = v === null ? null : safeDate(v); if (v === undefined) continue; }
    else if (v !== null) { v = safeString(v); if (v === undefined) continue; }
    result[key] = v;
  }
  return result;
}
function safeString(v) {
  if (typeof v !== 'string' || !v || v.length > 256 || /[\x00-\x1f\x7f]/.test(v) || /^(?:\/|[A-Za-z]:[\\/])/.test(v)) return undefined;
  return v;
}
function safeDate(v) { const n = Date.parse(v); return Number.isFinite(n) ? new Date(n).toISOString() : undefined; }
function deepFreeze(value) { if (value && typeof value==='object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; }
function failure(code, message, cause) { const e = new Error(message, { cause }); e.code = code; return e; }
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function defaultsRequest(data, workspaceKey, now) { return { schemaVersion: VERSION, requestId: crypto.randomUUID(), operationId: null, workspaceKey, projectId: null, projectLabel: null, attributionStatus:'known', activity:'system', subtask:'generation', trigger:'system', requestedProvider:'unknown', requestedModel:'unknown', provider:null, model:null, modelIdentitySource:'unknown', startedAt:now, completedAt:null, status:'in_flight', retryOfRequestId:null, attempt:1, validationOutcome:'not_applicable', inputUncached:null, cacheRead:null, cacheWrite:null, output:null, reasoning:null, totalTokens:null, usageCoverage:'unavailable', usageSource:'unavailable', normalizerVersion:1, errorCode:null, ...pick(data, requestFields), workspaceKey, schemaVersion: VERSION }; }
function defaultsOperation(data, workspaceKey, now) { return { schemaVersion:VERSION, operationId:crypto.randomUUID(), workspaceKey, projectId:null, projectLabel:null, activity:'system', trigger:'system', startedAt:now, completedAt:null, status:'in_flight', promptSubmissions:[], stages:[], reuse:[], ...pick(data, operationFields), workspaceKey, schemaVersion:VERSION }; }
class UsageStore {
  constructor({ stateDir, workspaceRoot, clock = () => new Date() }) {
    this.workspaceKey = workspaceKey(workspaceRoot); this.root = path.join(stateDir, 'usage', this.workspaceKey); this.lockPath = path.join(this.root, '.lock'); this.clock = clock; this.writerId = crypto.randomUUID(); this.queue = Promise.resolve(); this.degraded = false; this.cache = null; this.publicSnapshot = null; this.publicRecords = new WeakMap(); this.pendingTerminals = new Map();
  }
  now() { return new Date(this.clock()).toISOString(); }
  serial(fn) { const task = this.queue.then(fn, fn); this.queue = task.catch(() => {}); return task; }
  async lock() {
    await fs.mkdir(this.root, { recursive:true, mode:0o700 });
    if (!this.gitExclusionReady) {
      const ignore = path.join(path.dirname(this.root), '.gitignore');
      try { await fs.writeFile(ignore, '*\n', { mode:0o600, flag:'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await fs.lstat(ignore);
        if (!info.isFile() || info.isSymbolicLink() || !(await fs.readFile(ignore, 'utf8')).split(/\r?\n/).includes('*')) throw new Error('Usage directory Git exclusion is unavailable');
      }
      this.gitExclusionReady = true;
    }
    for (let i = 0; i < 1000; i++) {
      try { await fs.mkdir(this.lockPath, { mode:0o700 }); await fs.writeFile(path.join(this.lockPath,'owner'), JSON.stringify({pid:process.pid, writerId:this.writerId}), {mode:0o600}); return; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      // A dead owner's lock can be reclaimed. An owner-less lock may be in
      // the middle of creation, so only reclaim after a generous grace period.
      try { const stat = await fs.stat(this.lockPath); const owner = await fs.readFile(path.join(this.lockPath,'owner'),'utf8').then(JSON.parse).catch(() => ({})); if ((!owner.pid && Date.now()-stat.mtimeMs > 30000) || (owner.pid && !alive(owner.pid))) await fs.rm(this.lockPath,{recursive:true,force:true}); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Usage journal lock timed out');
  }
  async locked(fn) { return this.serial(async () => { try { await this.lock(); try { await this.recoverPending(); return await fn(); } finally { await fs.rm(this.lockPath,{recursive:true,force:true}); } } catch (e) { if (e.code === 'USAGE_LEDGER_CORRUPT') throw e; this.degraded = true; throw failure('USAGE_STORE_UNAVAILABLE','Usage ledger is unavailable',e); } }); }
  async recoverPending() {
    if (!this.degraded && !this.pendingTerminals.size) return;
    const state = await this.read(); let wrote = false;
    for (const [id,data] of this.pendingTerminals) {
      const request = this.cache.requests.get(id);
      if (!request) throw new Error('Unknown pending request');
      if (request.status === 'in_flight') { await this.append(state,'request_update',data,id); await this.read(); wrote = true; }
      this.pendingTerminals.delete(id);
    }
    // A failed start may have dispatched nothing; a durable checkpoint proves
    // writes work again before a report or another dispatch can proceed.
    if (this.degraded && !wrote) { await this.append(state,'health_checkpoint',{}); await this.read(); }
    this.degraded = false;
  }
  async read() {
    const entries = await fs.readdir(this.root);
    const names = entries.filter(n => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
    if (!this.cache) this.cache = { state:{ schemaVersion:VERSION, revision:0, trackingStartedAt:null, health:{degraded:false,gaps:[]}, operations:[], requests:[] }, offsets:new Map(), operations:new Map(), requests:new Map(), operationIndex:new Map(), requestIndex:new Map(), seen:new Set() };
    const c = this.cache, state = c.state;
    state.health.degraded = this.degraded;
    state.health.gaps = entries.filter(n => /^\d{4}-\d{2}\.jsonl\.[a-f0-9-]+\.truncated$/.test(n)).map(n => ({type:'truncated_tail',segment:n.slice(0,13)}));
    for (const [index,name] of names.entries()) {
      const file = path.join(this.root,name); const stat = await fs.stat(file); const offset = c.offsets.get(name) || 0;
      if (stat.size < offset) { this.cache = null; throw failure('USAGE_LEDGER_CORRUPT','Usage journal was modified'); }
      if (stat.size === offset) continue;
      const handle = await fs.open(file,'r'); let bytes;
      try { bytes = Buffer.alloc(stat.size - offset); await handle.read(bytes,0,bytes.length,offset); } finally { await handle.close(); }
      let content = bytes.toString('utf8');
      if (content && !content.endsWith('\n')) {
        if (index !== names.length - 1) throw failure('USAGE_LEDGER_CORRUPT','Usage journal contains a truncated segment');
        const pos = bytes.lastIndexOf(10); const tail = bytes.subarray(pos + 1); const quarantine = path.join(this.root, `${name}.${crypto.randomUUID()}.truncated`);
        await fs.writeFile(quarantine,tail,{mode:0o600,flag:'wx'}); await fs.truncate(file,offset+pos+1); content = bytes.subarray(0,pos+1).toString('utf8'); state.health.gaps.push({type:'truncated_tail',segment:name});
      }
      for (const line of content.split('\n')) {
        if (!line) continue; let event; try { event = JSON.parse(line); } catch { throw failure('USAGE_LEDGER_CORRUPT','Usage journal contains corrupt data'); }
        if (event.schemaVersion !== VERSION || !safeString(event.eventId) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !safeDate(event.timestamp) || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object') throw failure('USAGE_LEDGER_CORRUPT','Usage journal contains an invalid event');
        if (c.seen.has(event.eventId)) continue; c.seen.add(event.eventId);
        if (event.sequence <= state.revision) throw failure('USAGE_LEDGER_CORRUPT','Usage journal sequence is invalid'); state.revision = event.sequence;
        if (event.type === 'tracking') state.trackingStartedAt ||= event.timestamp;
        else if (event.type === 'health_checkpoint') {}
        else if (event.type === 'operation_start') { c.operations.set(event.data.operationId,event.data); c.operationIndex.set(event.data.operationId,state.operations.length); state.operations.push(event.data); }
        else if (event.type === 'operation_update') { const op = c.operations.get(event.id); if (!op) throw failure('USAGE_LEDGER_CORRUPT','Unknown usage operation'); const updated={...op,...event.data}; c.operations.set(event.id,updated); state.operations[c.operationIndex.get(event.id)]=updated; }
        else if (event.type === 'request_start') { const request={...event.data, _writerPid:event.writerPid}; c.requests.set(event.data.requestId,request); c.requestIndex.set(event.data.requestId,state.requests.length); state.requests.push(request); }
        else if (event.type === 'request_update') { const req = c.requests.get(event.id); if (!req) throw failure('USAGE_LEDGER_CORRUPT','Unknown usage request'); if (req.status === 'in_flight' || event.validation === true) { const updated={...req,...event.data}; c.requests.set(event.id,updated); state.requests[c.requestIndex.get(event.id)]=updated; } }
        else throw failure('USAGE_LEDGER_CORRUPT','Unknown usage journal event');
      }
      c.offsets.set(name,offset+Buffer.byteLength(content));
    }
    return state;
  }
  async append(state,type,data,id,extra={}) {
    const timestamp = this.now(); const event = {schemaVersion:VERSION,eventId:crypto.randomUUID(),sequence:state.revision+1,timestamp,type,...(id ? {id}:{}),writerPid:process.pid,writerId:this.writerId,data,...extra}; const line = JSON.stringify(event)+'\n';
    if (Buffer.byteLength(line)>MAX_EVENT_BYTES) throw new Error('Usage event exceeds size limit');
    const file = path.join(this.root,`${timestamp.slice(0,7)}.jsonl`); const handle = await fs.open(file,'a',0o600); try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); } return event;
  }
  async init() { return this.locked(async () => { const state = await this.read(); if (!state.trackingStartedAt) { await this.append(state,'tracking',{}); await this.read(); } for (const r of state.requests) if (r.status === 'in_flight' && !alive(r._writerPid)) { await this.append(state,'request_update',{status:'interrupted',completedAt:this.now(),errorCode:'PROCESS_INTERRUPTED'},r.requestId); await this.read(); } return this; }); }
  async startOperation(input={}) { return this.locked(async () => { const s=await this.read(); if (!s.trackingStartedAt) { await this.append(s,'tracking',{}); await this.read(); } const op=defaultsOperation(input,this.workspaceKey,this.now()); if (this.cache.operations.has(op.operationId)) throw new Error('Duplicate operation ID'); await this.append(s,'operation_start',op); return op; }); }
  async updateOperation(id,patch={}) { return this.locked(async () => { const s=await this.read(); if (!this.cache.operations.has(id)) throw new Error('Unknown operation'); const data=pick(patch,operationFields.filter(x=>!['operationId','workspaceKey','startedAt'].includes(x))); await this.append(s,'operation_update',data,id); }); }
  async startRequest(input={}) { return this.locked(async () => { const s=await this.read(); if (!s.trackingStartedAt) { await this.append(s,'tracking',{}); await this.read(); } const r=defaultsRequest(input,this.workspaceKey,this.now()); if (!r.operationId || !this.cache.operations.has(r.operationId)) throw new Error('Unknown operation'); if (this.cache.requests.has(r.requestId)) throw new Error('Duplicate request ID'); await this.append(s,'request_start',r); return r; }); }
  async checkpointRequest(id,usage={}) { return this.requestUpdate(id,pick(usage,usageFields)); }
  async finishRequest(id,patch={}) { const data={...pick(patch,terminalFields),status:enums.status.includes(patch.status) && patch.status !== 'in_flight' ? patch.status : 'completed',completedAt:safeDate(patch.completedAt)||this.now()}; if (!this.pendingTerminals.has(id) && this.pendingTerminals.size >= 10000) { this.degraded = true; throw failure('USAGE_STORE_UNAVAILABLE','Too many pending usage records'); } this.pendingTerminals.set(id,data); let error; for (let i=0;i<3;i++) { try { return await this.requestUpdate(id,data); } catch (e) { error=e; if (e.code !== 'USAGE_STORE_UNAVAILABLE') throw e; } } throw error; }
  async validationRequest(id,outcome) { if (!enums.validationOutcome.includes(outcome)) throw new Error('Invalid validation outcome'); return this.requestUpdate(id,{validationOutcome:outcome},true); }
  async requestUpdate(id,data,validation=false) { return this.locked(async () => { const s=await this.read(); const r=this.cache.requests.get(id); if (!r) throw new Error('Unknown request'); if (r.status !== 'in_flight' && !validation) return; if (validation && r.validationOutcome===data.validationOutcome) return; await this.append(s,'request_update',data,id,validation?{validation:true}:{}); }); }
  async snapshot() { return this.locked(async () => { const s=await this.read(); const healthKey=JSON.stringify(s.health); if (this.publicSnapshot && this.publicSnapshot.revision===s.revision && this.publicSnapshot.healthKey===healthKey) return this.publicSnapshot.value; const operations=s.operations.map(o=>{ let value=this.publicRecords.get(o); if (!value) { value=deepFreeze(structuredClone(o)); this.publicRecords.set(o,value); } return value; }); const requests=s.requests.map(r=>{ let value=this.publicRecords.get(r); if (!value) { const {_writerPid,...record}=r; value=Object.freeze(record); this.publicRecords.set(r,value); } return value; }); const value=Object.freeze({...s,health:deepFreeze(structuredClone(s.health)),operations:Object.freeze(operations),requests:Object.freeze(requests)}); this.publicSnapshot={revision:s.revision,healthKey,value}; return value; }); }
}
module.exports = { UsageStore, MAX_EVENT_BYTES };
