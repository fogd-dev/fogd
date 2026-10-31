import { readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { readPrivatePreviewRecordSource } from './private-record.mjs';
import { storageRequestInitialization, storageRequestCompletion, bindRequestStorage, validateStorageRecovery } from './storage-request-records.mjs';

const files = { initialization: ['storage.initialization.json', 16384], storage: ['storage.json', 65536],
  completion: ['storage.complete.json', 16384], recovery: ['storage.recovery.json', 131072] };
export async function readStorageRequestState(bound) {
  const names = (await readdir(bound.canonical)).sort(), allowed = Object.values(files).map(([name]) => name);
  if (!names.includes(files.initialization[0]) || names.some(name => !allowed.includes(name))) throw new Error('Storage setup layout refused');
  const result = {};
  for (const [key, [name, limit]] of Object.entries(files)) result[key] = names.includes(name) ? await readPrivatePreviewRecordSource(bound, name, limit) : null;
  if (!isDeepStrictEqual((await readdir(bound.canonical)).sort(), names)) throw new Error('Storage setup changed');
  return result;
}
export function checkedStorageRequestState(bound, setup, state, actual) {
  const original = state.initialization.value;
  if (!isDeepStrictEqual(original, storageRequestInitialization(bound.canonical, setup))) throw new Error('Storage setup intent refused');
  const storage = bindRequestStorage(original, actual ?? state.storage?.value), complete = storageRequestCompletion(original, storage);
  if (state.storage && !isDeepStrictEqual(state.storage.value, storage) || state.completion && !isDeepStrictEqual(state.completion.value, complete)) throw new Error('Storage setup metadata refused');
  return { original, storage, complete, recovery: validateStorageRecovery(bound, original, storage, state) };
}
