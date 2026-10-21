// This profile authorizes only complete inventories precommitted in the image.
import { readFile } from 'node:fs/promises';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { backendCronRuntime } from '/app/packages/platform/src/backend-runtime-identity.mjs';
import { runtimeVariant } from './retirement-policy.mjs';

export async function qualificationPolicy() {
  return JSON.parse(await readFile(new URL('./runtime-policy.json', import.meta.url), 'utf8'));
}
export async function guardedBackend() {
  const profile = runtimeVariant(await qualificationPolicy(), JSON.parse(process.env.FOGD_SLOTS));
  const backend = new Backend(); backend.crons = backendCronRuntime(backend, profile); return backend;
}
