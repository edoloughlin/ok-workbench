const fs = require('node:fs/promises');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/@earendil-works%2Fpi-ai/latest';
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function newer(latest, installed) {
  const a = VERSION.exec(latest); const b = VERSION.exec(installed);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return false;
}

function createPiVersionChecker({ stateDir, packageFile, fetchImpl = fetch, now = Date.now }) {
  const cacheFile = path.join(stateDir, 'pi-version-check.json');
  let pending;
  let memoryCache;
  async function check() {
    if (pending) return pending;
    pending = (async () => {
      const installed = JSON.parse(await fs.readFile(packageFile, 'utf8')).version;
      let cached = memoryCache;
      if (!cached) try { cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { /* no usable cache */ }
      const timestamp = now();
      const fresh = Number.isFinite(cached?.checkedAt) && cached.checkedAt <= timestamp && timestamp - cached.checkedAt < DAY_MS;
      if (!fresh) {
        let latest = null;
        try {
          const response = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('Registry request failed');
          const metadata = await response.json();
          if (!VERSION.test(metadata?.version)) throw new Error('Invalid registry version');
          latest = metadata.version;
        } catch { /* network failure must not disrupt settings */ }
        cached = { checkedAt: timestamp, latest };
        try { await fs.mkdir(stateDir, { recursive: true, mode: 0o700 }); await fs.writeFile(cacheFile, JSON.stringify(cached), { mode: 0o600 }); }
        catch { /* retain the in-process result even if state is read-only */ }
      }
      memoryCache = cached;
      return { installed, latest: VERSION.test(cached?.latest) ? cached.latest : null, updateAvailable: newer(cached?.latest, installed), checkedAt: cached?.checkedAt || null };
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { check };
}

module.exports = { createPiVersionChecker };
