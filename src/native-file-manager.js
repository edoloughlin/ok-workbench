'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function executable(file) { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } }
function createNativeFileManager({ platform = process.platform, env = process.env, spawnProcess = spawn, exists = executable, timeoutMs = 3000 } = {}) {
  function capability() {
    const names = platform === 'darwin' ? ['Show in Finder', 'Open in Finder'] : platform === 'win32' ? ['Show in File Explorer', 'Open in File Explorer'] : ['Open containing folder', 'Open in file manager'];
    let reason = null;
    if (env.OK_WORKBENCH_NATIVE_FILE_MANAGER === '0') reason = 'Disabled on the server';
    else if (!['darwin', 'linux', 'win32'].includes(platform)) reason = 'Unsupported server platform';
    else if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) reason = 'No graphical desktop session on the server';
    else if (platform === 'linux' && !(env.PATH || '').split(path.delimiter).some(dir => dir && exists(path.join(dir, 'xdg-open')))) reason = 'xdg-open is not available on the server';
    else if (platform === 'darwin' && !exists('/usr/bin/open')) reason = 'Finder launcher is not available on the server';
    return { platform: ['darwin', 'linux', 'win32'].includes(platform) ? platform : 'other', available: !reason, reason, fileLabel: names[0], directoryLabel: names[1] };
  }
  async function reveal(target, isDirectory) {
    const status = capability();
    if (!status.available) throw Object.assign(new Error(status.reason), { code: 'NATIVE_UNAVAILABLE', status: 503 });
    let command; let args; let mode;
    if (platform === 'darwin') { command = '/usr/bin/open'; args = isDirectory ? [target] : ['-R', target]; mode = isDirectory ? 'open-directory' : 'reveal'; }
    else if (platform === 'linux') { command = 'xdg-open'; args = [isDirectory ? target : path.dirname(target)]; mode = 'open-directory'; }
    else { command = 'explorer.exe'; args = isDirectory ? [target] : ['/select,', target]; mode = isDirectory ? 'open-directory' : 'reveal'; }
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(Object.assign(new Error('Could not open the server file manager'), { code: 'NATIVE_LAUNCH_FAILED', status: 502 })); else resolve(); };
      let child;
      const timer = setTimeout(() => { child?.kill(); done(new Error('Launcher timed out')); }, timeoutMs);
      try { child = spawnProcess(command, args, { shell: false, stdio: 'ignore', windowsHide: true }); }
      catch (error) { done(error); return; }
      child.once('error', done);
      // Explorer can remain running after accepting a request. Unix launchers
      // normally report whether the desktop accepted it via their exit status.
      if (platform === 'win32') child.once('spawn', () => { child.unref(); done(); });
      else child.once('exit', code => done(code === 0 ? null : new Error('Launcher failed')));
    });
    return { mode, launched: true };
  }
  return { capability, reveal };
}
module.exports = { createNativeFileManager };
