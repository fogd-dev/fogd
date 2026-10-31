import { hash, jsonBytes, uuid } from '../build-cache/paths.mjs';
import { executionKeys } from './execution-shape.mjs';
import { previewStorageRecoveryOperation, previewStorageWorkerSha256 } from './storage.mjs';
import { checkedIdentity, checkedDisk, checkedAdmission, checkedLoop, checkedRoles, storageUuid } from './storage-shape.mjs';

function fail(reason = 'uncertain') {
  const error = new Error('Read-only preview recovery refused; retain all records and resources; inspect an uncertain result before proceeding');
  error.code = 'PREVIEW_STORAGE_REFUSED'; error.reason = reason; throw error;
}
function checkedMount(mount, value, directory) {
  executionKeys(mount, ['target', 'source', 'fstype', 'uuid', 'options', 'fsroot', 'maj:min']);
  const options = mount.options.split(','), required = ['ro', 'nosuid', 'nodev', 'noexec', 'relatime'];
  if (mount.target !== directory + '/mount' || mount.source !== value.loop.name || mount.fstype !== 'ext4' || mount.uuid !== value.uuid ||
    mount.fsroot !== '/' || mount['maj:min'] !== value.loop['maj:min'] || new Set(options).size !== options.length ||
    !required.every(option => options.includes(option)) || !options.some(option => ['noload', 'norecovery'].includes(option)) ||
    options.some(option => ![...required, 'noload', 'norecovery'].includes(option))) fail();
}
function checkedRecovery(value, input, options) {
  executionKeys(value, ['schema', 'kind', 'id', 'operation', 'project', 'engineId', 'originalStorageSha256', 'uuid', 'admission',
    'rootIdentity', 'directoryIdentity', 'disk', 'loop', 'mount', 'roles', 'readOnly', 'resourcesRetained', 'executionAuthorized', 'ordinaryEnrollment']);
  if (value.schema !== 1 || value.kind !== 'fogd-preview-storage-readonly-recovery' || value.id !== options.recoveryId || !uuid(value.operation) ||
    value.project !== input.project || value.engineId !== input.engineId || value.uuid !== storageUuid(input.project) || value.originalStorageSha256 !== options.storageSha256 ||
    value.readOnly !== true || value.resourcesRetained !== true || value.executionAuthorized !== false || value.ordinaryEnrollment !== false) fail();
  checkedIdentity(value.rootIdentity); checkedIdentity(value.directoryIdentity); checkedDisk(value.disk); checkedAdmission(value.admission, value.disk);
  if (value.rootIdentity.device !== value.disk.device || value.directoryIdentity.device !== value.disk.device) fail();
  const directory = input.root + '/' + input.project;
  checkedLoop(value.loop, value.disk, directory, null); checkedMount(value.mount, value, directory); checkedRoles(value.roles);
  return value;
}
async function operation(input, options, action) {
  try {
    const recovery = checkedRecovery(await previewStorageRecoveryOperation(input, action, options), input, options);
    return { recovery, sha256: hash(jsonBytes(recovery)), workerSha256: previewStorageWorkerSha256,
      resourcesRetained: true, executionAuthorized: false, ordinaryEnrollment: false };
  } catch (error) { fail(error.code === 'PREVIEW_STORAGE_REFUSED' ? error.reason : 'uncertain'); }
}
export const recoverPreviewStorageReadOnly = (input, options) => operation(input, options, 'recover-readonly');
export const inspectPreviewStorageRecovery = (input, options) => operation(input, options, 'inspect-readonly');

export const reconcilePreviewStorageRecovery = (input, options) => operation(input, options, 'reconcile-readonly');
export const repairPreviewStorageRecoveryCompletion = (input, options) => operation(input, options, 'repair-readonly');
