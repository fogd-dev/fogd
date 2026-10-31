import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { hash, jsonBytes, uuid } from '../build-cache/paths.mjs';
import { executionKeys } from './execution-shape.mjs';

const worker = (await Promise.all(['admission.py', 'commands.py', 'reconciliation.py', 'host.py'].map(name => readFile(new URL('./storage/' + name, import.meta.url), 'utf8')))).join('\n');
export const previewStorageBytes = 1024 ** 3;
export const previewStorageChargeBytes = previewStorageBytes + 16 * 1024 ** 2;
export const previewStorageWorkerSha256 = hash(worker);
const refuse = (reason = 'uncertain') => {
  const error = new Error('Preview storage refused; retain its files, devices and mounts; do not retry provisioning');
  error.code = 'PREVIEW_STORAGE_REFUSED'; error.reason = reason; throw error;
};
function checkedRequest({ root, project, engineId }, action) {
  if (typeof root !== 'string' || !/^\/[A-Za-z0-9_./-]{1,200}$/.test(root) || root.endsWith('/') || posix.normalize(root) !== root ||
    !/^fogd-preview-[a-f0-9]{32}$/.test(project || '') || typeof engineId !== 'string' || !/^[^\x00-\x20\x7f]{1,256}$/.test(engineId)) refuse();
  return { action, root, project, engineId };
}
const roleNames = ['minio', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'controller',
  'controller-trust', 'controller-input', 'gateway-trust', 'gateway-input', 'ingress-trust', 'ingress-input'];
const counter = value => Number.isSafeInteger(value) && value > 0;
function checkedIdentity(value) {
  executionKeys(value, ['device', 'inode']);
  if (!counter(value.device) || !counter(value.inode)) refuse();
}
function checkedStorage(value, request) {
  executionKeys(value, ['schema', 'kind', 'project', 'engineId', 'uuid', 'bytes', 'rootIdentity', 'directoryIdentity', 'disk', 'loop', 'mount', 'roles', ...(value.schema === 2 ? ['admission'] : [])]);
  const directory = request.root + '/' + request.project, id = request.project.slice(13);
  const uuid = [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
  if (![1, 2].includes(value.schema) || value.kind !== 'fogd-preview-storage' || value.project !== request.project || value.engineId !== request.engineId ||
    value.uuid !== uuid || value.bytes !== previewStorageBytes) refuse();
  if (value.schema === 2) checkedAdmission(value.admission, value.disk);
  checkedIdentity(value.rootIdentity); checkedIdentity(value.directoryIdentity);
  checkedDisk(value.disk);
  checkedLoop(value.loop, value.disk, directory); checkedMount(value.mount, value.loop, directory, uuid);
  executionKeys(value.roles, roleNames);
  for (const role of roleNames) checkedIdentity(value.roles[role]);
  if (new Set(Object.values(value.roles).map(row => row.device)).size !== 1 ||
    new Set(Object.values(value.roles).map(row => row.inode)).size !== roleNames.length) refuse();
  return value;
}
function checkedDisk(value) {
  executionKeys(value, ['device', 'inode', 'bytes', 'allocatedBytes']);
  if (!counter(value.device) || !counter(value.inode) || value.bytes !== previewStorageBytes ||
    !counter(value.allocatedBytes) || value.allocatedBytes < previewStorageBytes) refuse();
}
function checkedAdmission(value, disk) {
  executionKeys(value, ['profileId', 'reservation', 'chargeBytes']);
  if (![value.profileId, value.reservation].every(v => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v)) ||
    value.chargeBytes !== previewStorageChargeBytes || disk.allocatedBytes > previewStorageChargeBytes) refuse();
}
function checkedLoop(value, disk, directory) {
  executionKeys(value, ['name', 'back-file', 'back-ino', 'back-maj:min', 'maj:min', 'ro', 'autoclear', 'offset', 'sizelimit']);
  if (!/^\/dev\/loop[0-9]+$/.test(value.name) || value['back-file'] !== directory + '/disk.img' || value['back-ino'] !== disk.inode ||
    !/^[0-9]+:[0-9]+$/.test(value['back-maj:min']) || !/^7:[0-9]+$/.test(value['maj:min']) ||
    value.ro !== false || value.autoclear !== false || value.offset !== 0 || value.sizelimit !== 0) refuse();
}
function checkedMount(value, loop, directory, uuid) {
  executionKeys(value, ['target', 'source', 'fstype', 'uuid', 'options', 'fsroot', 'maj:min']);
  if (value.target !== directory + '/mount' || value.source !== loop.name || value.fstype !== 'ext4' || value.uuid !== uuid ||
    value.fsroot !== '/' || value['maj:min'] !== loop['maj:min'] || value.options !== 'rw,nosuid,nodev,noexec,relatime') refuse();
}
async function hostReply(input, request, member) {
  try {
    const output = await input.runHost(['python3', '-c', worker], { inputText: jsonBytes(request) });
    if (typeof output !== 'string' || Buffer.byteLength(output) > 65536) refuse();
    const reply = JSON.parse(output);
    if (reply?.ok === false) {
      executionKeys(reply, ['ok', 'reason']);
      refuse(['pending', 'capacity'].includes(reply.reason) ? reply.reason : 'uncertain');
    }
    executionKeys(reply, ['ok', member]);
    if (reply.ok !== true) refuse();
    return reply[member];
  } catch (error) { if (error.code === 'PREVIEW_STORAGE_REFUSED') throw error; refuse(); }
}
async function operation(input, action, extra = {}) {
  const request = { ...checkedRequest(input, action), ...extra };
  try {
    const storage = checkedStorage(await hostReply(input, request, 'storage'), request);
    if (action === 'reconcile' && storage.schema !== 2) refuse();
    return { storage, sha256: hash(jsonBytes(storage)), workerSha256: previewStorageWorkerSha256,
      resourcesRetained: true, executionAuthorized: false, ordinaryEnrollment: false };
  } catch (error) { if (error.code === 'PREVIEW_STORAGE_REFUSED') throw error; refuse(); }
}

// runHost must execute on the independently selected Linux Docker host as root.
// This component provisions storage only; allocation/startup integration must
// independently bind the engine, signed target and realized volume sources.
export const preparePreviewStorage = input => operation(input, 'prepare');
export function reconcilePreviewStorage(input, { operation: operationId } = {}) {
  if (!uuid(operationId)) refuse();
  return operation(input, 'reconcile', { operation: operationId });
}
export function inspectPreviewStorage(input, { phase = 'any' } = {}) {
  const action = { any: 'inspect', empty: 'inspect-empty', installed: 'inspect-installed' }[phase];
  if (!action) refuse();
  return operation(input, action);
}

export function validatePreviewStorageReceipt(value, { project, engineId }) {
  try {
    executionKeys(value, ['storage', 'sha256', 'workerSha256', 'resourcesRetained', 'executionAuthorized', 'ordinaryEnrollment']);
    const suffix = '/' + project + '/mount', target = value.storage.mount.target;
    if (typeof target !== 'string' || !target.endsWith(suffix)) refuse();
    const request = checkedRequest({ root: target.slice(0, -suffix.length), project, engineId }, 'inspect');
    checkedStorage(value.storage, request);
    if (value.sha256 !== hash(jsonBytes(value.storage)) || !/^[a-f0-9]{64}$/.test(value.workerSha256) ||
      value.resourcesRetained !== true || value.executionAuthorized !== false || value.ordinaryEnrollment !== false) refuse();
    return structuredClone(value);
  } catch { refuse(); }
}

export function previewStorageAdmissionOperation(input, request) {
  if (!['initialize', 'admission', 'quarantine'].includes(request?.action)) refuse();
  return hostReply(input, request, 'admission');
}
