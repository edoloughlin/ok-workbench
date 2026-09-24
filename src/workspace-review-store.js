'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCHEMA_VERSION = 1;
const TRACE_TTL_MS = 5 * 86400000;
function workspaceKey(root) { return crypto.createHash('sha256').update(path.resolve(root)).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function defaults() { return { schemaVersion: SCHEMA_VERSION, revision: 0, automatic: false, provider: null, model: null, effort: null, confirmations: { meteredAutomatic: false, belowRecommendedModel: false }, excludedProjects: [], activityTracking: true, timezone: 'UTC', dailyAutomaticLimit: 6 }; }
function defaultControls() { return { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: null, priorityOverrides: {}, cadenceOverrides: {}, guidance: [], issueFeedback: {}, feedbackLog: [], feedbackCheckpoint: {}, requests: [] }; }
function defaultRuntime() { return { schemaVersion: SCHEMA_VERSION, attempts: [], retry: {}, invalidReviewStreak: {}, paused: false, nextCheckAt: null, pendingRerun: false, pendingRerunVersion: 0, changeDueAt: null, changeDeadlineAt: null, lastJob: null, pipelineAttempts: [], pipelineRetry: {}, recurrenceTokens: {} }; }
async function readJson(file, fallback) { try { const value = JSON.parse(await fs.readFile(file, 'utf8')); return value?.schemaVersion === SCHEMA_VERSION ? value : fallback(); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback(); throw error; } }
async function writeJson(file, value, indentation = 0) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temporary, JSON.stringify(value, null, indentation), { mode: 0o600 }); await fs.rename(temporary, file); }
class WorkspaceReviewStore {
  constructor({ stateDir, workspaceRoot }) { this.root = path.join(stateDir, 'workspace-review', workspaceKey(workspaceRoot)); this.lockDirectory = path.join(this.root, '.write-lock'); this.writes = Promise.resolve(); }
  file(name) { return path.join(this.root, name); }
  async settings() { const settings = await readJson(this.file('settings.json'), defaults); delete settings.reportableProjects; return settings; }
  async controls() { return readJson(this.file('controls.json'), defaultControls); }
  async runtime() { return readJson(this.file('runtime.json'), defaultRuntime); }
  async latest() { return readJson(this.file('latest.json'), () => null); }
  projectFile(projectId) { const digest = crypto.createHash('sha256').update(String(projectId)).digest('hex'); return this.file(path.join('projects', `${digest}.json`)); }
  traceDirectory() { return this.file(path.join('projects', 'trace')); }
  async pruneTraces(now = new Date()) {
    const directory = this.traceDirectory();
    const projects = await fs.readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const project of projects) {
      if (!project.isDirectory() || !/^[a-f0-9]{64}$/.test(project.name)) continue;
      const projectDirectory = path.join(directory, project.name);
      const traces = await fs.readdir(projectDirectory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      for (const trace of traces) {
        if (!trace.isFile() || !/^[a-f0-9-]+\.json$/.test(trace.name)) continue;
        const file = path.join(projectDirectory, trace.name);
        const stat = await fs.stat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (stat) {
          let expiresAt = Number.NaN;
          try { expiresAt = Date.parse(JSON.parse(await fs.readFile(file, 'utf8')).expiresAt); } catch {}
          if (!Number.isFinite(expiresAt)) expiresAt = stat.mtimeMs + TRACE_TTL_MS;
          if (now.getTime() >= expiresAt) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      const remaining = await fs.readdir(projectDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      if (!remaining.length) await fs.rmdir(projectDirectory).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; });
    }
  }
  async hasTraces() {
    const projects = await fs.readdir(this.traceDirectory(), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const project of projects) {
      if (!project.isDirectory() || !/^[a-f0-9]{64}$/.test(project.name)) continue;
      const traces = await fs.readdir(path.join(this.traceDirectory(), project.name), { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      if (traces.some(item => item.isFile() && /^[a-f0-9-]+\.json$/.test(item.name))) return true;
    }
    return false;
  }
  async saveTrace({ projectId, stage, jobId, attemptNumber, prompt, evidence, response = null, errorCode = null, diagnostic = null, validationMessage = null, recovery = null, createdAt = new Date().toISOString() }) {
    const projectKey = crypto.createHash('sha256').update(String(projectId || 'workspace')).digest('hex');
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const directory = path.join(this.traceDirectory(), projectKey);
    await writeJson(path.join(directory, `${id}.json`), { schemaVersion: SCHEMA_VERSION, createdAt, expiresAt: new Date(Date.parse(createdAt) + TRACE_TTL_MS).toISOString(), projectId: projectId || null, stage, jobId, attemptNumber, request: { prompt, evidence }, response, failure: { code: errorCode, diagnostic, ...(validationMessage ? { message: validationMessage } : {}), ...(recovery ? { recovery } : {}) } }, 2);
    this.startTraceCleaner();
    await this.pruneTraces();
    return path.join(directory, `${id}.json`);
  }
  startTraceCleaner() {
    const worker = path.join(__dirname, 'workspace-review-trace-cleaner.js');
    const child = spawn(process.execPath, [worker, this.traceDirectory()], { detached: true, stdio: 'ignore', windowsHide: true, env: {} });
    child.once('error', error => console.error(`[${new Date().toISOString()}] [ok-workbench] workspace review expiry worker could not start (${error.code || 'SPAWN_FAILED'})`));
    child.unref();
  }
  async projectAssessment(projectId) {
    const record = await readJson(this.projectFile(projectId), () => null);
    return record?.cacheVersion === 1 && record.projectId === projectId ? record : null;
  }
  async projectAssessments() {
    const directory = this.file('projects');
    const names = await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const records = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => readJson(path.join(directory, name), () => null)));
    return records.filter(record => record?.cacheVersion === 1 && typeof record.projectId === 'string');
  }
  async saveProjectAssessment(record) { return this.serial(async () => { await writeJson(this.projectFile(record.projectId), { ...record, cacheVersion: 1 }); return record; }); }
  async reconcileProjectEligibility(projectIds, now = new Date()) { return this.serial(async () => {
    const eligible = new Set(projectIds); const directory = this.file('projects');
    const names = await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of names.filter(item => /^[a-f0-9]{64}\.json$/.test(item))) {
      const file = path.join(directory, name); const record = await readJson(file, () => null);
      if (!record?.projectId || record.cacheVersion !== 1) continue;
      if (eligible.has(record.projectId)) {
        if (record.ineligibleSince) { delete record.ineligibleSince; await writeJson(file, record); }
      } else if (!record.ineligibleSince) { record.ineligibleSince = now.toISOString(); await writeJson(file, record); }
      else if (now.getTime() - Date.parse(record.ineligibleSince) >= 30 * 86400000) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }); }
  async activity() { return readJson(this.file('activity.json'), () => ({ schemaVersion: SCHEMA_VERSION, days: {} })); }
  async acquireWriteLock() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const token = crypto.randomUUID(); const reclaimDirectory = `${this.lockDirectory}.reclaim`;
    for (let attempt = 0; attempt < 2_000; attempt++) {
      try {
        await fs.mkdir(this.lockDirectory, { mode: 0o700 });
        await fs.writeFile(path.join(this.lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { mode: 0o600 });
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      // A crashed process cannot release its directory lock. Exactly one
      // waiter performs stale-lock recovery at a time; live owners are never
      // displaced, and the age fallback covers PID reuse or partial writes.
      let reclaim = false;
      try { await fs.mkdir(reclaimDirectory, { mode: 0o700 }); reclaim = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (reclaim) {
        try {
          let owner = null; let lockAge = 0;
          try { owner = JSON.parse(await fs.readFile(path.join(this.lockDirectory, 'owner.json'), 'utf8')); } catch {}
          try { lockAge = Date.now() - (await fs.stat(this.lockDirectory)).mtimeMs; } catch {}
          let ownerAlive = true;
          if (Number.isInteger(owner?.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (error) { ownerAlive = error.code !== 'ESRCH'; }
          }
          if ((!ownerAlive || lockAge > 5 * 60_000) && lockAge > 100) await fs.rm(this.lockDirectory, { recursive: true, force: true });
        } finally { await fs.rmdir(reclaimDirectory).catch(() => {}); }
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Object.assign(new Error('Timed out waiting for the workspace review store lock'), { code: 'STORE_LOCK_TIMEOUT' });
  }
  async serial(work) {
    const previous = this.writes; let release; this.writes = new Promise(resolve => { release = resolve; }); await previous;
    let token = null;
    try {
      token = await this.acquireWriteLock();
      return await work();
    } finally {
      try {
        if (token) {
          try {
            const owner = JSON.parse(await fs.readFile(path.join(this.lockDirectory, 'owner.json'), 'utf8'));
            if (owner.token === token) await fs.rm(this.lockDirectory, { recursive: true, force: true });
          } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        }
      } finally { release(); }
    }
  }
  async saveSettings(value, expectedRevision) { return this.serial(async () => { const current = await this.settings(); if (expectedRevision !== current.revision) { const error = new Error('Settings changed in another tab'); error.code = 'STALE_REVISION'; throw error; } const saved = { ...defaults(), ...clone(value), schemaVersion: SCHEMA_VERSION, revision: current.revision + 1 }; await writeJson(this.file('settings.json'), saved); return saved; }); }
  async applyControl({ expectedRevision, requestId, operation }) { return this.serial(async () => {
    const current = await this.controls(); const old = current.requests.find(request => request.id === requestId); if (old) { if (old.payload !== JSON.stringify(operation)) { const error = new Error('Request ID was reused with a different payload'); error.code = 'STALE_REVISION'; throw error; } return old.response; }
    if (expectedRevision !== current.revision) { const error = new Error('Controls changed in another tab'); error.code = 'STALE_REVISION'; throw error; }
    const controls = clone(current); const now = new Date().toISOString(); let applied;
    if (operation.operation === 'priority') { controls.priorityOverrides[operation.projectId] = { tier: operation.tier, reason: operation.reason, createdAt: now, expiresAt: operation.expiresAt || null }; applied = controls.priorityOverrides[operation.projectId]; }
    else if (operation.operation === 'clear_priority') { delete controls.priorityOverrides[operation.projectId]; applied = null; }
    else if (operation.operation === 'cadence') { if (operation.cadence) controls.cadenceOverrides[operation.projectId] = { cadence: operation.cadence, createdAt: now }; else delete controls.cadenceOverrides[operation.projectId]; applied = controls.cadenceOverrides[operation.projectId] || null; }
    else if (operation.operation === 'guidance') { const entry = { id: crypto.randomUUID(), projectId: operation.projectId || null, issueId: operation.issueId || null, questionId: operation.questionId || null, text: operation.text, createdAt: now }; controls.guidance.push(entry); applied = entry; }
    else if (operation.operation === 'remove_guidance') { controls.guidance = controls.guidance.filter(entry => entry.id !== operation.guidanceId); applied = null; }
    else if (operation.operation === 'feedback') { const entry = { id: crypto.randomUUID(), issueId: operation.issueId, evidenceSignature: operation.evidenceSignature, action: operation.action, until: operation.until || null, reason: operation.reason || null, createdAt: now }; controls.issueFeedback[entry.id] = entry; controls.feedbackLog = [...(controls.feedbackLog || []), entry]; applied = entry; }
    else if (operation.operation === 'undo_feedback') { const entry = controls.issueFeedback[operation.feedbackId]; if (!entry) { const error = new Error('Feedback no longer exists'); error.code = 'NOT_FOUND'; throw error; } delete controls.issueFeedback[operation.feedbackId]; controls.feedbackLog = [...(controls.feedbackLog || []), { id: crypto.randomUUID(), issueId: entry.issueId, evidenceSignature: entry.evidenceSignature, action: 'undo', until: null, reason: null, targetId: entry.id, createdAt: now }]; applied = { undone: operation.feedbackId }; }
    else { const error = new Error('Unsupported controls operation'); error.code = 'INVALID_REQUEST'; throw error; }
    controls.guidance = controls.guidance.slice(-200); if ((controls.feedbackLog || []).length > 500) { controls.feedbackCheckpoint = clone(controls.issueFeedback); controls.feedbackLog = controls.feedbackLog.slice(-500); }
    const response = { controlsRevision: current.revision + 1, applied }; controls.revision++; controls.updatedAt = now; controls.requests = [...controls.requests, { id: requestId, payload: JSON.stringify(operation), response }].slice(-100); await writeJson(this.file('controls.json'), controls); return response;
  }); }
  async saveReview(record) { return this.serial(async () => { await writeJson(this.file(path.join('history', `${record.id}.json`)), record); const names = (await fs.readdir(this.file('history')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter(name => name.endsWith('.json')); const history = (await Promise.all(names.map(async name => ({ name, record: await readJson(this.file(path.join('history', name)), () => null) })))).filter(item => item.record).sort((a, b) => String(b.record.completedAt || '').localeCompare(String(a.record.completedAt || ''))); for (const item of history.slice(30)) await fs.unlink(this.file(path.join('history', item.name))).catch(() => {}); await writeJson(this.file('latest.json'), record); return record; }); }
  async updateRuntime(update) { return this.serial(async () => { const runtime = await this.runtime(); const result = await update(runtime) || runtime; result.schemaVersion = SCHEMA_VERSION; await writeJson(this.file('runtime.json'), result); return result; }); }
  async recordActivity(projectId, kind, now = new Date()) { return this.serial(async () => { const settings = await this.settings(); if (!settings.activityTracking) return null; const activity = await this.activity(); const day = now.toISOString().slice(0, 10); activity.days[day] ||= {}; activity.days[day][projectId] ||= { chatTurns: 0, changedFiles: 0 }; if (kind === 'chat') activity.days[day][projectId].chatTurns++; if (kind === 'change') activity.days[day][projectId].changedFiles++; const cutoff = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10); for (const key of Object.keys(activity.days)) if (key < cutoff) delete activity.days[key]; await writeJson(this.file('activity.json'), activity); return activity; }); }
  async clearActivity() { return this.serial(async () => { await fs.unlink(this.file('activity.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }); }); }
  async saveReport(projectId, report) { return this.serial(async () => { const directory = this.file(path.join('reports', projectId)); await writeJson(path.join(directory, `${report.id}.json`), report); const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')); const entries = (await Promise.all(names.map(async name => ({ name, report: await readJson(path.join(directory, name), () => null) })))).filter(item => item.report).sort((a, b) => String(b.report.createdAt || '').localeCompare(String(a.report.createdAt || ''))); for (const item of entries.slice(10)) await fs.unlink(path.join(directory, item.name)).catch(() => {}); return report; }); }
  async reports(projectId) {
    const directory = this.file(path.join('reports', projectId));
    const entries = await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const reports = await Promise.all(entries.filter(name => name.endsWith('.json')).map(name => readJson(path.join(directory, name), () => null)));
    return reports.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10);
  }
}
module.exports = { WorkspaceReviewStore, SCHEMA_VERSION, workspaceKey, defaults, defaultControls, defaultRuntime };
