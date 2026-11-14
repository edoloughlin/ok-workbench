import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const source = new URL('../src/pi-runtime-patch.js', import.meta.url);
const installed = new URL('../dist/pi-runtime-patch.js', import.meta.url);
const require = createRequire(import.meta.url);
try {
  const { applyPiRuntimePatches } = require(fileURLToPath(existsSync(source) ? source : installed));
  await applyPiRuntimePatches();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
