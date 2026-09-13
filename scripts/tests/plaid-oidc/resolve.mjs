// Execute the Edge module unchanged with Node's package resolution in CI.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'npm:jose@6.2.12') return nextResolve('jose', { ...context, parentURL: import.meta.url });
  return nextResolve(specifier, context);
}
