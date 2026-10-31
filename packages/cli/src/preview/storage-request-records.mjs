import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes } from '../build-cache/paths.mjs';
import { validatePreviewStorageReceipt, previewStorageWorkerSha256 } from './storage.mjs';

export function storageRequestInitialization(directory, setup) {
  const { profile, preparation } = setup;
  return { schema: 1, kind: 'fogd-preview-storage-request-initialization', directory,
    profileDirectory: profile.directory, profileSha256: setup.profileSha256, preparationDirectory: setup.directory,
    preparationSha256: setup.preparationSha256, runtime: preparation.runtime, engineId: profile.engineId,
    project: 'fogd-preview-' + preparation.id.replaceAll('-', ''), storageRoot: profile.storagePolicy.root, storagePolicyId: profile.storagePolicy.id, storageRootIdentity: profile.storagePolicy.rootIdentity };
}
export function storageRequestCompletion(original, storage) {
  return { schema: 1, kind: 'fogd-preview-storage-request-completion', initializationSha256: hash(jsonBytes(original)), storageSha256: hash(jsonBytes(storage)) };
}
export function bindRequestStorage(original, input) {
  const receipt = validatePreviewStorageReceipt(input, { project: original.project, engineId: original.engineId });
  if (receipt.workerSha256 !== previewStorageWorkerSha256 || receipt.storage.admission.profileId !== original.storagePolicyId ||
    !isDeepStrictEqual(receipt.storage.rootIdentity, original.storageRootIdentity) || receipt.storage.mount.target !== original.storageRoot + '/' + original.project + '/mount') throw new Error('Preview storage request binding refused');
  return receipt;
}

export const storageSource = source => source ? { sha256: source.sha256, bytes: source.bytes, identity: source.identity } : null;
export function storageRecoveryReview(bound, original, storage, files) {
  return { schema: 1, kind: 'fogd-preview-storage-setup-review', directory: bound.canonical,
    directoryIdentity: { device: bound.dev, inode: bound.ino }, binding: original, actualStorage: storage,
    sources: { initialization: storageSource(files.initialization), storage: storageSource(files.storage), completion: storageSource(files.completion) } };
}
export const storageRecoveryRecord = review => ({ schema: 1, kind: 'fogd-preview-storage-setup-recovery', review, reviewSha256: hash(jsonBytes(review)) });

// Original existing files must keep both bytes and inodes. Originally missing
// files may only become the exact receipt/completion checked against the host.
export function validateStorageRecovery(bound, original, storage, files) {
  if (!files.recovery) return null;
  const record = files.recovery.value, sources = record.review?.sources;
  if (!sources || sources.storage && !files.storage || sources.completion && !files.completion || sources.storage && sources.completion) throw new Error('Recovery sources refused');
  const expectedFiles = { initialization: files.initialization,
    storage: sources.storage ? files.storage : null, completion: sources.completion ? files.completion : null };
  const expected = storageRecoveryRecord(storageRecoveryReview(bound, original, storage, expectedFiles));
  if (!isDeepStrictEqual(record, expected)) throw new Error('Recovery record refused');
  return record;
}
