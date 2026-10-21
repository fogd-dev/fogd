// Immutable private qualification composition; the normal entry point is unchanged.
import { readFile } from 'node:fs/promises';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { backendCronRuntime } from '/app/packages/platform/src/backend-runtime-identity.mjs';

export async function qualificationPolicy() {
  return JSON.parse(await readFile(new URL('./runtime-policy.json', import.meta.url), 'utf8'));
}
export async function guardedBackend() {
  const profile = await qualificationPolicy();
  const backend = new Backend();
  backend.crons = backendCronRuntime(backend, profile);
  return backend;
}
