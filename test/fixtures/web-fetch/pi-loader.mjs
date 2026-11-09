// Test-only substitutions at module boundaries; never loaded by the app.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/pi-harness.mjs')) {
    if (specifier === '@earendil-works/pi-coding-agent') return { url: new URL('./pi-runtime-fixture.mjs', import.meta.url).href, shortCircuit: true };
    if (specifier === './web-fetch.mjs') return { url: new URL('./fetch-fixture.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
