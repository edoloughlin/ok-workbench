import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

async function resolvePackage(directory, name) {
  let candidateRoot = directory;
  while (directory !== path.dirname(directory)) {
    try {
      const candidate = path.join(candidateRoot, 'node_modules', ...name.split('/'));
      await fs.access(path.join(candidate, 'package.json'));
      return candidate;
    } catch { /* Keep walking toward node_modules. */ }
    candidateRoot = path.dirname(candidateRoot);
    directory = path.dirname(directory);
  }
  throw new Error(`Could not resolve ${name} from ${directory}`);
}

async function packageLicense(directory) {
  const candidates = (await fs.readdir(directory)).filter(name => /^(?:license|copying|notice)(?:\.[\w-]+)?$/i.test(name)).sort();
  if (!candidates.length) return 'No license text file was included with this package.';
  return (await fs.readFile(path.join(directory, candidates[0]), 'utf8')).trim();
}

async function copyPackageLicense(directory, destination) {
  const candidates = (await fs.readdir(directory)).filter(name => /^(?:license|copying|notice)(?:\.[\w-]+)?$/i.test(name)).sort();
  if (candidates.length) await fs.copyFile(path.join(directory, candidates[0]), destination);
}

async function mermaidNotices(mermaidSource) {
  const packages = new Map();
  async function visit(directory) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) return;
    packages.set(key, { directory, manifest });
    const optional = new Set(Object.keys(manifest.optionalDependencies || {}));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      try {
        await visit(await resolvePackage(directory, name));
      } catch (error) {
        if (!optional.has(name)) throw error;
      }
    }
  }
  await visit(mermaidSource);
  const entries = await Promise.all([...packages.values()].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)).map(async ({ directory, manifest }) => `## ${manifest.name} ${manifest.version}\n\nDeclared license: ${manifest.license || 'not declared'}\n\n${await packageLicense(directory)}`));
  return `# Third-party notices for the vendored Mermaid browser bundle\n\nThis file is generated during the OK Workbench build from Mermaid's resolved production dependencies.\n\n${entries.join('\n\n')}`;
}

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
for (const file of await fs.readdir(path.join(root, 'src'))) await fs.cp(path.join(root, 'src', file), path.join(dist, file), { recursive: true });
await fs.cp(path.join(root, 'seed'), path.join(dist, 'seed'), { recursive: true });
const mermaidSource = path.join(root, 'node_modules', 'mermaid');
const mermaidDestination = path.join(dist, 'public', 'vendor', 'mermaid');
await fs.mkdir(mermaidDestination, { recursive: true });
await Promise.all([
  copyPackageLicense(mermaidSource, path.join(mermaidDestination, 'LICENSE')),
  fs.copyFile(path.join(mermaidSource, 'dist', 'mermaid.esm.min.mjs'), path.join(mermaidDestination, 'mermaid.esm.min.mjs')),
  fs.cp(path.join(mermaidSource, 'dist', 'chunks', 'mermaid.esm.min'), path.join(mermaidDestination, 'chunks', 'mermaid.esm.min'), { recursive: true, filter: source => !source.endsWith('.map') }),
  fs.writeFile(path.join(mermaidDestination, 'THIRD-PARTY-NOTICES.md'), await mermaidNotices(mermaidSource))
]);
await fs.chmod(path.join(dist, 'bin', 'ok-workbench.mjs'), 0o755);
