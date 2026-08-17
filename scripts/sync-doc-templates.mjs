import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'seed', 'workspace', 'templates');
const destination = path.join(root, 'docs', 'templates');

await fs.rm(destination, { recursive: true, force: true });
await fs.cp(source, destination, { recursive: true });
