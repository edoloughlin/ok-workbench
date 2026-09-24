'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const TRACE_TTL_MS = 5 * 86400000;
const directory = path.resolve(process.argv[2] || '');
const lockDirectory = path.join(directory, '.cleanup-worker');

if (!path.isAbsolute(directory) || path.basename(directory) !== 'trace' || path.basename(path.dirname(directory)) !== 'projects') process.exit(2);

async function ownsLock() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      await fs.writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = null;
      try { pid = JSON.parse(await fs.readFile(path.join(lockDirectory, 'owner.json'), 'utf8')).pid; } catch {}
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) try { process.kill(pid, 0); } catch (probeError) { alive = probeError.code !== 'ESRCH'; }
      if (!alive) {
        const age = await fs.stat(lockDirectory).then(stat => Date.now() - stat.mtimeMs).catch(() => 0);
        if (age < 30000) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      }
      if (alive) return false;
      await fs.rm(lockDirectory, { recursive: true, force: true });
    }
  }
  return false;
}

async function cleanExpired() {
  let nextExpiry = Number.POSITIVE_INFINITY;
  let hasTraces = false;
  const projects = await fs.readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const project of projects) {
    if (!project.isDirectory() || !/^[a-f0-9]{64}$/.test(project.name)) continue;
    const projectDirectory = path.join(directory, project.name);
    const traces = await fs.readdir(projectDirectory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const trace of traces) {
      if (!trace.isFile() || !/^[a-f0-9-]+\.json$/.test(trace.name)) continue;
      const file = path.join(projectDirectory, trace.name);
      const stat = await fs.stat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!stat) continue;
      let expiresAt = Number.NaN;
      try { expiresAt = Date.parse(JSON.parse(await fs.readFile(file, 'utf8')).expiresAt); } catch {}
      if (!Number.isFinite(expiresAt)) expiresAt = stat.mtimeMs + TRACE_TTL_MS;
      if (expiresAt <= Date.now()) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      else { hasTraces = true; nextExpiry = Math.min(nextExpiry, expiresAt); }
    }
    const remaining = await fs.readdir(projectDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    if (!remaining.length) await fs.rmdir(projectDirectory).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; });
  }
  return hasTraces ? nextExpiry : null;
}

async function main() {
  if (!(await ownsLock())) return;
  try {
    while (true) {
      const nextExpiry = await cleanExpired();
      if (nextExpiry === null) {
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        await new Promise(resolve => setTimeout(resolve, Math.max(1, nextExpiry - Date.now())));
      }
    }
  } finally { await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => {}); }
}

main().catch(() => process.exitCode = 1);
