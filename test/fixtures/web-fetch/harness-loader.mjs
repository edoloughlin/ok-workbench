// Test-only loader: route the server's provider boundary to a deterministic
// tool-call fixture without changing production code or network policy.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === './pi-harness.mjs' && context.parentURL?.endsWith('/dist/server.js')) {
    return { url: new URL('./harness-fixture.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
