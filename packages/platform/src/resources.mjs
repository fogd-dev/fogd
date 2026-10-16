import { isDeepStrictEqual } from 'node:util';

// Approved declarations are a monotonic floor, including failed activations.
export function resourceChanges(current, next) {
  if (!current) return { r2Added: next.r2 };
  for (const key of ['script', 'd1', 'durable']) {
    if (!isDeepStrictEqual(current[key], next[key])) throw new Error(`Resource identities changed: ${key}`);
  }
  const previous = new Map(current.r2.map(binding => [binding.binding, binding]));
  const proposed = new Map(next.r2.map(binding => [binding.binding, binding]));
  for (const [name, binding] of previous) {
    if (!isDeepStrictEqual(binding, proposed.get(name))) throw new Error(`Resource identities changed: R2 ${name}`);
  }
  return { r2Added: next.r2.filter(binding => !previous.has(binding.binding)) };
}
