#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = path.join(dist, 'seed', 'workspace');
const version = '1.0.0';
const usage = `ok-workbench ${version}\n\nCommands:\n  init [directory] [--yes] [--merge] [--git]\n  serve [--root directory] [--port port]\n  doctor [--root directory]\n  migrate-state --yes\n  seed diff [directory]`;
const home = path.resolve(os.homedir());
function fatal(message) { console.error(`ok-workbench: ${message}`); process.exitCode = 1; }
function isDangerous(target) { const states = ['ok-workbench', 'okf-workbench', 'agents-browser'].map(name => path.join(home, '.local', 'state', name)); return target === path.parse(target).root || target === home || states.some(state => target === state || target.startsWith(`${state}${path.sep}`)); }
async function entries(directory) { try { return await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function commandWorks(command, args) { return new Promise(resolve => { const child = spawn(command, args, { stdio: 'ignore' }); child.on('error', () => resolve(false)); child.on('exit', code => resolve(code === 0)); }); }
function configDirectory(name = 'ok-workbench') { return process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, name) : path.join(home, '.config', name); }
async function savedRoot() { for (const directory of [configDirectory(), configDirectory('okf-workbench')]) { try { const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')); if (typeof config.workspaceRoot === 'string') return config.workspaceRoot; } catch { /* try the next compatible location */ } } return null; }
async function defaultRoot() { const explicit = process.env.OK_WORKSPACE_ROOT || process.env.OKF_WORKSPACE_ROOT || process.env.AGENTS_BUNDLE_ROOT; if (explicit) return path.resolve(explicit); const configured = await savedRoot(); if (configured) return path.resolve(configured); const local = path.resolve(process.cwd(), 'workspace'); if (await entries(local)) return local; return path.join(home, 'workspace'); }
async function init(args) {
  const merge = args.includes('--merge'); const git = args.includes('--git'); const yes = args.includes('--yes');
  const value = args.find(arg => !arg.startsWith('--')) || path.join(process.cwd(), 'workspace'); const target = path.resolve(value);
  if (isDangerous(target)) return fatal(`refusing dangerous target ${target}`);
  const existing = await entries(target);
  async function conflictsIn(from, to) { const conflicts = []; for (const item of await fs.readdir(from, { withFileTypes: true })) { const source = path.join(from, item.name), output = path.join(to, item.name); let present; try { present = await fs.lstat(output); } catch (error) { if (error.code === 'ENOENT') continue; throw error; } if (item.isDirectory() && present.isDirectory()) conflicts.push(...await conflictsIn(source, output)); else conflicts.push(path.relative(target, output)); } return conflicts; }
  if (existing?.length && !merge) { const conflicts = await conflictsIn(seed, target); return fatal(`target is not empty (${existing.length} entries); merge would preserve ${conflicts.length} conflicting seed path(s)${conflicts.length ? `:\n${conflicts.map(item => `  ${item}`).join('\n')}` : ''}\nRerun with --merge to copy only missing seed files.`); }
  if (!yes && !process.stdin.isTTY) return fatal('non-interactive init requires --yes');
  await fs.mkdir(target, { recursive: true, mode: 0o755 });
  if (await fs.realpath(target) !== target) return fatal('refusing a target reached through a symbolic link');
  const conflicts = [];
  async function copy(from, to) { for (const item of await fs.readdir(from, { withFileTypes: true })) { const source = path.join(from, item.name), output = path.join(to, item.name); let present; try { present = await fs.lstat(output); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (item.isDirectory()) { if (present && !present.isDirectory()) { conflicts.push(path.relative(target, output)); continue; } await fs.mkdir(output, { recursive: true, mode: 0o755 }); await copy(source, output); } else if (present) conflicts.push(path.relative(target, output)); else await fs.copyFile(source, output); } }
  await copy(seed, target);
  if (conflicts.length) console.log(`Seed copied without overwriting ${conflicts.length} existing file(s):\n${conflicts.map(x => `  ${x}`).join('\n')}`);
  if (git && !(await entries(path.join(target, '.git')))) await new Promise((resolve, reject) => { const child = spawn('git', ['init'], { cwd: target, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('git init failed'))); });
  console.log(`Initialized workspace bundle at ${target}\nNext: ok-workbench serve --root ${target}\nProvider setup: sign in from the local chat pane, or set provider credentials in the server environment.`);
}
async function serve(args) { const index = args.indexOf('--root'); const root = index >= 0 ? path.resolve(args[index + 1]) : await defaultRoot(); const port = args.indexOf('--port'); const env = { ...process.env, OK_WORKSPACE_ROOT: root, PORT: port >= 0 ? args[port + 1] : process.env.PORT }; const child = spawn(process.execPath, [path.join(dist, 'server.js')], { env, stdio: 'inherit' }); child.on('exit', code => process.exitCode = code || 0); }
async function doctor(args) { const index = args.indexOf('--root'); const root = index >= 0 ? path.resolve(args[index + 1]) : await defaultRoot(); const state = process.env.OK_WORKBENCH_STATE_DIR || process.env.OKF_WORKBENCH_STATE_DIR || path.join(home, '.local', 'state', 'ok-workbench'); const provider = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.LLM_COMPATIBLE_API_KEY || await fs.access(path.join(state, 'chat', 'pi-agent', 'auth.json')).then(() => true).catch(() => false)); const checks = [['Node >=22.19', Number(process.versions.node.split('.')[0]) >= 22], ['Workspace root', !!(await entries(root))], ['Seed available', !!(await entries(seed))], ['Git', await commandWorks('git', ['--version'])], ['Bubblewrap user namespaces', await commandWorks('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/usr/bin/true'])], ['State outside workspace', !state.startsWith(root + path.sep)], ['Provider configuration present', provider]]; for (const [name, ok] of checks) console.log(`${ok ? 'ok' : 'warn'}  ${name}`); console.log(`root: ${root}`); }
async function migrateState(args) { const oldStates = ['okf-workbench', 'agents-browser'].map(name => path.join(home, '.local', 'state', name)); const newState = path.join(home, '.local', 'state', 'ok-workbench'); if (!args.includes('--yes')) return fatal('state migration is explicit; rerun with --yes after reviewing the source and destination'); if (await entries(newState)) return fatal('new state already exists; refusing to merge credential data'); for (const candidate of oldStates) if (await entries(candidate)) { await fs.cp(candidate, newState, { recursive: true, errorOnExist: true }); console.log(`Copied legacy state from ${candidate} to ${newState}; review it before removing the old directory yourself.`); return; } return fatal('no legacy state exists'); }
async function fileHash(file) { return `sha256:${crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')}`; }
async function seedDiff(args) {
  const requested = args.find(arg => !arg.startsWith('--'));
  const target = requested ? path.resolve(requested) : await defaultRoot();
  let installed; let packaged;
  try { installed = JSON.parse(await fs.readFile(path.join(target, 'bundle-manifest.json'), 'utf8')); } catch { return fatal(`no bundle manifest found in ${target}`); }
  try { packaged = JSON.parse(await fs.readFile(path.join(seed, 'bundle-manifest.json'), 'utf8')); } catch { return fatal('packaged seed manifest is unavailable'); }
  const original = installed.managed_files || {}; const current = packaged.managed_files || {};
  const states = { unchanged: [], modified: [], missing: [], added: [] };
  for (const [relative, originalHash] of Object.entries(original)) {
    const file = path.join(target, relative);
    try { (await fileHash(file)) === originalHash ? states.unchanged.push(relative) : states.modified.push(relative); } catch { states.missing.push(relative); }
  }
  for (const relative of Object.keys(current)) if (!(relative in original)) states.added.push(relative);
  console.log(`Seed diff for ${target}`);
  for (const name of ['unchanged', 'modified', 'missing', 'added']) console.log(`${name}: ${states[name].length}${states[name].length ? `\n${states[name].map(item => `  ${item}`).join('\n')}` : ''}`);
  if (installed.seed_version !== packaged.seed_version) console.log(`seed version: ${installed.seed_version || 'unknown'} → ${packaged.seed_version || 'unknown'}`);
  console.log('No files were changed. `seed update` is intentionally not available in 1.0.0.');
}
async function main() { const [command, ...args] = process.argv.slice(2); if (command === 'init') return init(args); if (command === 'serve') return serve(args); if (command === 'doctor') return doctor(args); if (command === 'migrate-state') return migrateState(args); if (command === 'seed' && args[0] === 'diff') return seedDiff(args.slice(1)); console.log(usage); }
main().catch(error => fatal(error.message));
