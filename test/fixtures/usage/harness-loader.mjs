export async function resolve(specifier, context, nextResolve) {
  if (specifier === './pi-harness.mjs' && context.parentURL?.endsWith('/dist/server.js')) return { url: new URL('./harness.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
