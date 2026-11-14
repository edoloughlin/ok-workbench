export function resolveRuntimePackage(name) {
  return import.meta.resolve(name);
}
